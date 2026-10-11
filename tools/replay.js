/**
 * Repairs registrations whose sheet row or confirmation email never went out.
 *
 *   npm run replay          show what is outstanding
 *   npm run replay -- --fix actually resend / re-sync
 *
 * Registrations are never lost — Postgres is the source of truth — so anything
 * that failed downstream (bad credentials, an outage) can be replayed later
 * without asking the runner to register again.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
for (const file of ['.env.local', '.env']) {
  const p = path.join(root, file);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const FIX = process.argv.includes('--fix');

const { sql, dbConfigured, markSheetSynced, markEmailSent } = await import('../lib/db.js');
const { appendRegistration, sheetsConfigured } = await import('../lib/sheets.js');
const { sendConfirmation, explainMailError, missingEnv } = await import('../lib/mailer.js');
const { confirmationHtml, confirmationText } = await import('../lib/template.js');
const { FORM, AGREEMENT, PRIVACY } = await import('../lib/form-schema.js');

const APP_NAME = process.env.APP_NAME || 'Southville Run For A Cause 2026';

if (!dbConfigured()) {
  console.error('No DATABASE_URL set.');
  process.exit(1);
}

const rows = await sql()`
  SELECT reference, created_at, full_name, email, answers, sheet_synced, email_sent
    FROM registrations
   WHERE sheet_synced = FALSE OR email_sent = FALSE
   ORDER BY created_at ASC`;

if (!rows.length) {
  console.log('\n  Nothing outstanding — every registration is in the sheet and has been emailed.\n');
  process.exit(0);
}

console.log(`\n  ${rows.length} registration(s) need attention:\n`);
for (const r of rows) {
  const needs = [!r.sheet_synced && 'sheet', !r.email_sent && 'email'].filter(Boolean).join(' + ');
  console.log(`    ${r.reference.padEnd(12)} ${String(r.full_name || '').padEnd(30)} needs: ${needs}`);
}

if (!FIX) {
  console.log('\n  Re-run with --fix to send them:  npm run replay -- --fix\n');
  process.exit(0);
}

const mailMissing = missingEnv();
if (mailMissing.length) console.warn(`\n  ! Email still unconfigured (missing ${mailMissing.join(', ')}) — skipping emails.`);
if (!sheetsConfigured()) console.warn('  ! Sheet still unconfigured — skipping sheet rows.');

console.log('');
let sheetOk = 0, sheetBad = 0, mailOk = 0, mailBad = 0;

for (const r of rows) {
  const labelled = r.answers || {};

  if (!r.sheet_synced && sheetsConfigured()) {
    const out = await appendRegistration({ reference: r.reference, labelled });
    await markSheetSynced(r.reference, out.ok, out.error);
    if (out.ok) { sheetOk++; console.log(`    ${r.reference}  sheet  OK`); }
    else { sheetBad++; console.log(`    ${r.reference}  sheet  FAILED — ${out.error}`); }
  }

  if (!r.email_sent && !mailMissing.length) {
    const to = r.email || labelled[FORM.fields.find((f) => f.type === 'email')?.label];
    if (!to) { mailBad++; console.log(`    ${r.reference}  email  SKIPPED — no address on file`); continue; }

    // The same rows the original email carried, the two consents included.
    const answers = [...FORM.fields, AGREEMENT, PRIVACY].map((f) => [f.label, labelled[f.label] ?? '']);
    const when = new Date(r.created_at).toLocaleString('en-PH', {
      dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Manila',
    });
    try {
      await sendConfirmation({
        to,
        name: r.full_name || to,
        subject: `Registration confirmed — ${APP_NAME}`,
        html: confirmationHtml({ answers, appName: APP_NAME, ref: r.reference, when }),
        text: confirmationText({ answers, appName: APP_NAME, ref: r.reference, when }),
      });
      await markEmailSent(r.reference, true);
      mailOk++;
      console.log(`    ${r.reference}  email  SENT to ${to}`);
    } catch (err) {
      const why = explainMailError(err);
      await markEmailSent(r.reference, false, why);
      mailBad++;
      console.log(`    ${r.reference}  email  FAILED — ${why}`);
    }
  }
}

console.log(`\n  sheet: ${sheetOk} sent, ${sheetBad} failed`);
console.log(`  email: ${mailOk} sent, ${mailBad} failed\n`);
process.exitCode = sheetBad || mailBad ? 1 : 0;
