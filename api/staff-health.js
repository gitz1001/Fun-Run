import { requireStaff } from '../lib/staff-auth.js';

/**
 * Reports which pieces of configuration the RUNNING deployment can actually
 * see. Names and booleans only — never a value — so it is safe to read, and
 * it is behind the staff session anyway.
 *
 *   GET /api/staff-health
 *
 * This exists because "I added it in the dashboard" and "the deployment has
 * it" are different things: environment variables are read at build time, so
 * a variable added after the last deploy is invisible until you redeploy.
 */

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'GET only' });
  }
  // Set before the guard: the 401 that turns a stranger away is a response
  // like any other, and must not sit in a shared cache either.
  res.setHeader('Cache-Control', 'no-store, private');

  if (!requireStaff(req, res)) return;

  const present = (k) => Boolean(process.env[k]);
  const env = {
    GMAIL_USER: present('GMAIL_USER'),
    GOOGLE_CLIENT_ID: present('GOOGLE_CLIENT_ID'),
    GOOGLE_CLIENT_SECRET: present('GOOGLE_CLIENT_SECRET'),
    GOOGLE_REFRESH_TOKEN: present('GOOGLE_REFRESH_TOKEN'),
    SHEET_ID: present('SHEET_ID'),
    SHEET_TAB: present('SHEET_TAB'),
    DATABASE_URL: present('DATABASE_URL') || present('POSTGRES_URL'),
    STAFF_PASSWORD: present('STAFF_PASSWORD'),
    STAFF_SECRET: present('STAFF_SECRET'),
    SITE_URL: present('SITE_URL'),
  };

  const { driveConfigured, checkDrive } = await import('../lib/google-drive.js');
  env.GOOGLE_DRIVE_FOLDER_ID = present('GOOGLE_DRIVE_FOLDER_ID');
  env.GOOGLE_DRIVE = driveConfigured();

  const checks = { env };
  try {
    if (!driveConfigured()) checks.drive = { ok: false, error: 'Google Drive OAuth or folder ID is missing' };
    else {
      const folder = await checkDrive();
      checks.drive = { ok: true, folder: folder.name };
    }
  } catch (err) {
    checks.drive = { ok: false, error: err.message };
  }

  // Live checks, each isolated so one failure does not hide the others.
  try {
    const { missingEnv, createTransport, explainMailError } = await import('../lib/mailer.js');
    const miss = missingEnv();
    if (miss.length) checks.smtp = { ok: false, error: `missing ${miss.join(', ')}` };
    else {
      try {
        await createTransport().verify();
        checks.smtp = { ok: true };
      } catch (err) {
        checks.smtp = { ok: false, error: explainMailError(err) };
      }
    }
  } catch (err) {
    checks.smtp = { ok: false, error: err.message };
  }

  try {
    const { sheetsConfigured, ensureSheet, sheetTab } = await import('../lib/sheets.js');
    if (!sheetsConfigured()) checks.sheet = { ok: false, error: 'SHEET_ID or Google OAuth missing' };
    else {
      const r = await ensureSheet();
      checks.sheet = { ok: true, tab: sheetTab(), headers: r.headers };
    }
  } catch (err) {
    checks.sheet = { ok: false, error: err.message };
  }

  try {
    const { dbConfigured, sql } = await import('../lib/db.js');
    if (!dbConfigured()) checks.database = { ok: false, error: 'no DATABASE_URL' };
    else {
      const [{ n }] = await sql()`SELECT count(*)::int AS n FROM registrations`;
      const [{ bad }] = await sql()`SELECT count(*)::int AS bad FROM registrations
                                     WHERE sheet_synced = FALSE OR email_sent = FALSE`;
      checks.database = { ok: true, registrations: n, needingAttention: bad };
    }
  } catch (err) {
    checks.database = { ok: false, error: err.message };
  }

  checks.deployment = {
    vercelEnv: process.env.VERCEL_ENV || 'local',
    commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || 'unknown',
    deployedAt: process.env.VERCEL_DEPLOYMENT_ID ? undefined : 'local run',
  };

  const allGood = checks.smtp?.ok && checks.sheet?.ok && checks.database?.ok && checks.drive?.ok;
  return res.status(200).json({ ok: true, healthy: Boolean(allGood), ...checks });
}
