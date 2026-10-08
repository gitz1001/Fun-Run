/**
 * Clears out receipts nobody registered with.
 *
 *   npm run sweep            list what would go
 *   npm run sweep -- --fix   delete them from Google Drive
 *
 * A runner can attach a receipt and then close the tab, and the upload
 * endpoint is public, so files accumulate that belong to no registration.
 * This removes the ones that are more than a day old.
 *
 * It only ever deletes file ids from the uploads table — files this app put
 * in Drive itself — and never one that any registration's receipt link
 * mentions. Drive's delete is permanent, which is why this is a command
 * somebody runs on purpose and not something a web request can trigger.
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
const HOURS = 24;

const { dbConfigured, ensureSchema, abandonedUploads, forgetUpload } = await import('../lib/db.js');
const { driveConfigured, deleteDriveFile } = await import('../lib/google-drive.js');

if (!dbConfigured()) {
  console.error('No DATABASE_URL set.');
  process.exit(1);
}

await ensureSchema();
const rows = await abandonedUploads(HOURS);

if (!rows.length) {
  console.log(`\n  Nothing to sweep — no unused upload is older than ${HOURS} hours.\n`);
  process.exit(0);
}

console.log(`\n  ${rows.length} upload(s) older than ${HOURS} hours belong to no registration:\n`);
for (const r of rows) {
  console.log(`    ${r.file_id}   uploaded ${new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')}`);
}

if (!FIX) {
  console.log('\n  Re-run with --fix to delete them from Google Drive:  npm run sweep -- --fix\n');
  process.exit(0);
}

if (!driveConfigured()) {
  console.error('\n  Google Drive is not configured, so nothing was deleted.\n');
  process.exit(1);
}

console.log('');
let gone = 0, failed = 0;
for (const r of rows) {
  try {
    const ok = await deleteDriveFile(r.file_id);
    if (!ok) throw new Error('not a deletable file id');
    await forgetUpload(r.file_id);
    gone++;
    console.log(`    ${r.file_id}  deleted`);
  } catch (err) {
    failed++;
    console.log(`    ${r.file_id}  FAILED — ${err.message}`);
  }
}

console.log(`\n  ${gone} deleted, ${failed} failed.\n`);
process.exitCode = failed ? 1 : 0;
