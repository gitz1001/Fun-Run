import { neon } from '@neondatabase/serverless';
import { FORM } from './form-schema.js';
import { newReference } from './reference.js';

/**
 * Postgres is the source of truth for registrations. The Google Sheet is a
 * mirror, so a Sheet outage never loses a runner's entry.
 *
 * Connection string comes from whichever variable the platform provides:
 *   DATABASE_URL          (Neon / most providers)
 *   POSTGRES_URL          (Vercel Postgres integration)
 *
 * The table deliberately keeps only a few fixed columns plus a JSONB blob of
 * every answer. The form's questions are regenerated whenever the Google Form
 * changes, so pinning a column per question would break on the next import.
 */

export function connectionString() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_POSTGRES_URL || '';
}

export function dbConfigured() {
  return Boolean(connectionString());
}

let _sql = null;
export function sql() {
  if (!dbConfigured()) throw new Error('No DATABASE_URL / POSTGRES_URL is set.');
  if (!_sql) _sql = neon(connectionString());
  return _sql;
}

/** For tests: swap in a fake tagged-template client. */
export function __setClient(fn) { _sql = fn; }

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS registrations (
  id             BIGSERIAL PRIMARY KEY,
  reference      TEXT        NOT NULL UNIQUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  full_name      TEXT,
  email          TEXT,
  proof_url      TEXT,
  answers        JSONB       NOT NULL,
  -- Nullable on purpose: NULL means the row predates the waiver box, which
  -- is not the same thing as a runner who declined it.
  waiver_agreed  BOOLEAN,
  waiver_agreed_at TIMESTAMPTZ,
  sheet_synced   BOOLEAN     NOT NULL DEFAULT FALSE,
  sheet_error    TEXT,
  email_sent     BOOLEAN     NOT NULL DEFAULT FALSE,
  email_error    TEXT,
  ip             TEXT
);

-- A table created before the waiver existed keeps its old shape: CREATE TABLE
-- IF NOT EXISTS will not touch it. These add the two columns to it, and are
-- no-ops on every run after the first.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS waiver_agreed BOOLEAN;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS waiver_agreed_at TIMESTAMPTZ;

-- The privacy consent gets the same proof the waiver has: a column of its own
-- and the server's clock for when it was given.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS privacy_agreed BOOLEAN;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS privacy_agreed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS registrations_email_idx      ON registrations (lower(email));
CREATE INDEX IF NOT EXISTS registrations_created_at_idx ON registrations (created_at DESC);
CREATE INDEX IF NOT EXISTS registrations_answers_idx    ON registrations USING GIN (answers);

-- Every receipt this app has put in Google Drive. A registration may only
-- name a file listed here, and a file is only ever deleted by its id from
-- here, so nothing a browser sends can point the app at another Drive file.
-- reference is NULL until a registration takes the file, 'hold:...' while one
-- is being written, and the registration's reference afterwards.
CREATE TABLE IF NOT EXISTS uploads (
  file_id     TEXT        PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip          TEXT,
  reference   TEXT
);
CREATE INDEX IF NOT EXISTS uploads_created_at_idx ON uploads (created_at);

-- Counters for lib/rate-limit.js, one row per key per fixed window.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket        TEXT        NOT NULL,
  key           TEXT        NOT NULL,
  window_start  TIMESTAMPTZ NOT NULL,
  count         INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, key, window_start)
);
`;

export async function initSchema() {
  const q = sql();
  // neon's http client takes one statement per call.
  for (const stmt of SCHEMA_SQL.split(';').map((s) => s.trim()).filter(Boolean)) {
    await q.query(stmt);
  }
}

/**
 * Brings an older database up to the current shape, once per warm instance.
 *
 * A deploy that adds a table would otherwise break uploads until somebody
 * remembered to run "npm run db:init". One cheap query settles whether there
 * is anything to do, and the statements above are all safe to repeat.
 */
let _ready = null;
export function ensureSchema() {
  if (!_ready) {
    _ready = (async () => {
      const q = sql();
      const [row] = await q`
        SELECT to_regclass('public.uploads') IS NOT NULL AS uploads,
               to_regclass('public.rate_limits') IS NOT NULL AS limits,
               EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'registrations'
                          AND column_name = 'privacy_agreed_at') AS privacy`;
      if (row?.uploads && row?.limits && row?.privacy) return;
      try {
        await initSchema();
      } catch (err) {
        // Two instances starting together can both reach CREATE TABLE, and
        // the loser gets a duplicate-object error for work the winner has
        // just done. Every statement is repeatable, so go round once more.
        console.warn('[db] schema upgrade retried:', err.message);
        await initSchema();
      }
    })().catch((err) => { _ready = null; throw err; });
  }
  return _ready;
}

/** For tests. */
export function __resetSchemaCheck() { _ready = null; }

/** Pulls the convenience columns out of the answer map, whatever it is called. */
export function summarise(values) {
  const fileField = FORM.fields.find((f) => f.type === 'file');
  return {
    full_name: values[FORM.nameField] || '',
    email: values[FORM.emailField] || '',
    proof_url: fileField ? values[fileField.name] || '' : '',
  };
}

/**
 * Writes one registration. This is the step that decides whether someone is
 * registered — the confirmation email is sent only if this succeeds.
 */
export async function saveRegistration({ values, labelled, ip, agreed = null, privacy = null, attempts = 5 }) {
  const q = sql();
  const { full_name, email, proof_url } = summarise(values);
  // null stays null: it means the submission said nothing about the waiver,
  // which is not the same as a runner who declined.
  const waiver = agreed === null || agreed === undefined ? null : Boolean(agreed);
  // Stamped here rather than taken from the browser: a client clock is not
  // evidence of anything.
  const now = new Date().toISOString();
  const agreedAt = waiver === true ? now : null;
  const consent = privacy === null || privacy === undefined ? null : Boolean(privacy);
  const consentAt = consent === true ? now : null;

  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const reference = newReference();
    try {
      const rows = await q`
        INSERT INTO registrations
               (reference, full_name, email, proof_url, answers, ip,
                waiver_agreed, waiver_agreed_at, privacy_agreed, privacy_agreed_at)
        VALUES (${reference}, ${full_name}, ${email}, ${proof_url}, ${JSON.stringify(labelled)}, ${ip || null},
                ${waiver}, ${agreedAt}, ${consent}, ${consentAt})
        RETURNING id, reference, created_at, waiver_agreed, waiver_agreed_at
      `;
      return rows[0];
    } catch (err) {
      // 23505 = unique_violation. Anything else is a genuine failure.
      const dup = err?.code === '23505' || /duplicate key|unique constraint/i.test(err?.message || '');
      if (!dup) throw err;
      lastErr = err;
      console.warn(`[db] reference collision on ${reference}, retrying (${i + 1}/${attempts})`);
    }
  }
  throw lastErr ?? new Error('Could not allocate a unique reference.');
}

/** Records what happened downstream, so failures are visible without log diving. */
export async function markSheetSynced(reference, ok, error = null) {
  const q = sql();
  await q`UPDATE registrations
             SET sheet_synced = ${ok}, sheet_error = ${ok ? null : String(error).slice(0, 500)}
           WHERE reference = ${reference}`;
}

export async function markEmailSent(reference, ok, error = null) {
  const q = sql();
  await q`UPDATE registrations
             SET email_sent = ${ok}, email_error = ${ok ? null : String(error).slice(0, 500)}
           WHERE reference = ${reference}`;
}

/** How many already chose a given race category — for capacity limits later. */
export async function countByAnswer(label, value) {
  const q = sql();
  const rows = await q`SELECT count(*)::int AS n FROM registrations
                        WHERE answers ->> ${label} = ${value}`;
  return rows[0]?.n ?? 0;
}

/* --- receipts ---------------------------------------------------------- */

/** Notes a file the app has just put in Drive, so a registration may name it. */
export async function recordUpload(fileId, ip) {
  const q = sql();
  await q`INSERT INTO uploads (file_id, ip) VALUES (${fileId}, ${ip || null})
          ON CONFLICT (file_id) DO NOTHING`;
}

/** Has any registration, from before the uploads table or after, used this file? */
export async function receiptAlreadyUsed(fileId) {
  const q = sql();
  const rows = await q`SELECT 1 AS used FROM registrations
                        WHERE strpos(COALESCE(proof_url, ''), ${fileId}) > 0 LIMIT 1`;
  return rows.length > 0;
}

/** Is this a file the app uploaded? The receipt proxy serves nothing else. */
export async function uploadKnown(fileId) {
  const q = sql();
  const rows = await q`SELECT 1 AS known FROM uploads WHERE file_id = ${fileId}`;
  return rows.length > 0;
}

/**
 * Takes an unused upload for a registration that is about to be written.
 * Returns false when the id is unknown or another registration already has
 * it — one statement, so two submissions cannot both win.
 */
export async function holdUpload(fileId, hold) {
  const q = sql();
  const rows = await q`UPDATE uploads SET reference = ${hold}
                        WHERE file_id = ${fileId} AND reference IS NULL
                    RETURNING file_id`;
  return rows.length > 0;
}

/** The registration was written: the file is now its receipt. */
export async function settleUpload(fileId, hold, reference) {
  const q = sql();
  await q`UPDATE uploads SET reference = ${reference}
           WHERE file_id = ${fileId} AND reference = ${hold}`;
}

/** The registration was not written: the file is free to be submitted again. */
export async function releaseUpload(fileId, hold) {
  const q = sql();
  await q`UPDATE uploads SET reference = NULL
           WHERE file_id = ${fileId} AND reference = ${hold}`;
}

/**
 * Uploads nobody registered with: never taken, or held by a request that died,
 * and old enough that the runner is not still filling in the form. A file a
 * registration's link mentions is never listed, whatever this table says.
 */
export async function abandonedUploads(olderThanHours = 24) {
  const q = sql();
  return q`SELECT u.file_id, u.created_at
             FROM uploads u
            WHERE (u.reference IS NULL OR u.reference LIKE 'hold:%')
              AND u.created_at < now() - make_interval(hours => ${olderThanHours}::int)
              AND NOT EXISTS (SELECT 1 FROM registrations r
                               WHERE strpos(COALESCE(r.proof_url, ''), u.file_id) > 0)
            ORDER BY u.created_at`;
}

export async function forgetUpload(fileId) {
  const q = sql();
  await q`DELETE FROM uploads WHERE file_id = ${fileId}`;
}

export async function recentRegistrations(limit = 50) {
  const q = sql();
  return q`SELECT reference, created_at, full_name, email, proof_url,
                  waiver_agreed, waiver_agreed_at, sheet_synced, email_sent
             FROM registrations
            ORDER BY created_at DESC
            LIMIT ${limit}`;
}
