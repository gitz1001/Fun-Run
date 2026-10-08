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

CREATE INDEX IF NOT EXISTS registrations_email_idx      ON registrations (lower(email));
CREATE INDEX IF NOT EXISTS registrations_created_at_idx ON registrations (created_at DESC);
CREATE INDEX IF NOT EXISTS registrations_answers_idx    ON registrations USING GIN (answers);
`;

export async function initSchema() {
  const q = sql();
  // neon's http client takes one statement per call.
  for (const stmt of SCHEMA_SQL.split(';').map((s) => s.trim()).filter(Boolean)) {
    await q.query(stmt);
  }
}

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
export async function saveRegistration({ values, labelled, ip, agreed = null, attempts = 5 }) {
  const q = sql();
  const { full_name, email, proof_url } = summarise(values);
  // null stays null: it means the submission said nothing about the waiver,
  // which is not the same as a runner who declined.
  const waiver = agreed === null || agreed === undefined ? null : Boolean(agreed);
  // Stamped here rather than taken from the browser: a client clock is not
  // evidence of anything.
  const agreedAt = waiver === true ? new Date().toISOString() : null;

  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const reference = newReference();
    try {
      const rows = await q`
        INSERT INTO registrations
               (reference, full_name, email, proof_url, answers, ip,
                waiver_agreed, waiver_agreed_at)
        VALUES (${reference}, ${full_name}, ${email}, ${proof_url}, ${JSON.stringify(labelled)}, ${ip || null},
                ${waiver}, ${agreedAt})
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

export async function recentRegistrations(limit = 50) {
  const q = sql();
  return q`SELECT reference, created_at, full_name, email, proof_url,
                  waiver_agreed, waiver_agreed_at, sheet_synced, email_sent
             FROM registrations
            ORDER BY created_at DESC
            LIMIT ${limit}`;
}
