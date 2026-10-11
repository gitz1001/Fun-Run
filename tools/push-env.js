/**
 * Pushes the values in .env.local up to Vercel, so the dashboard never has to
 * be edited by hand.
 *
 *   npx vercel login      (once)
 *   npx vercel link       (once — pick the sfo-system project)
 *   npm run push-env      dry run: shows what it would set
 *   npm run push-env -- --yes    actually set them, then redeploy
 *
 * Values are piped straight into the Vercel CLI; they are never printed.
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const APPLY = process.argv.includes('--yes');

// Everything production needs. Blob and Postgres are injected by their own
// integrations, so they are deliberately not in this list.
const WANTED = [
  'GMAIL_USER',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  // Without this one production has no folder to upload to, and every
  // receipt is turned away with "File uploads are not set up yet".
  'GOOGLE_DRIVE_FOLDER_ID',
  'SHEET_ID',
  'SHEET_TAB',
  'STAFF_PASSWORD',
  'STAFF_SECRET',
  'SITE_URL',
  'APP_NAME',
  'MAIL_FROM_NAME',
  'ADMIN_COPY',
];

const envPath = path.join(root, '.env.local');
if (!existsSync(envPath)) {
  console.error('No .env.local found.');
  process.exit(1);
}

const values = {};
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  // The first line for a name wins, as it does in doctor and replay. This
  // used to take the last, so a file holding the same name twice passed
  // "npm run doctor" on one token and deployed the other.
  if (m && !(m[1] in values)) values[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const ready = WANTED.filter((k) => values[k]);
const blank = WANTED.filter((k) => !values[k]);

console.log('\n  From .env.local:\n');
for (const k of ready) console.log(`    [x] ${k.padEnd(22)} ${values[k].length} chars`);
for (const k of blank) console.log(`    [ ] ${k.padEnd(22)} empty — will be skipped`);

// `vercel link` writes project.json for a plain link, or repo.json when the
// project is linked through its git repository. Either counts as linked.
const linked =
  existsSync(path.join(root, '.vercel', 'project.json')) ||
  existsSync(path.join(root, '.vercel', 'repo.json'));

if (!linked) {
  console.log('\n  This project is not linked to Vercel yet. Run these first:\n');
  console.log('    npx vercel login');
  console.log('    npx vercel link\n');
  process.exit(1);
}

if (!APPLY) {
  console.log(`\n  Dry run. To push ${ready.length} variable(s) to Production:\n`);
  console.log('    npm run push-env -- --yes\n');
  process.exit(0);
}

console.log('\n  Pushing to Production...\n');
let ok = 0, failed = 0;

for (const key of ready) {
  // Remove any existing value first, otherwise `env add` refuses.
  spawnSync('npx', ['vercel', 'env', 'rm', key, 'production', '--yes'],
    { cwd: root, stdio: 'ignore', shell: true });

  const r = spawnSync('npx', ['vercel', 'env', 'add', key, 'production'], {
    cwd: root,
    input: values[key],          // value never appears in the terminal
    encoding: 'utf8',
    shell: true,
  });

  if (r.status === 0) { ok++; console.log(`    set  ${key}`); }
  else {
    failed++;
    console.log(`    FAIL ${key} — ${(r.stderr || '').trim().split('\n').pop()}`);
  }
}

console.log(`\n  ${ok} set, ${failed} failed.`);
if (ok) {
  console.log('\n  Now redeploy so the new build picks them up:\n');
  console.log('    npx vercel --prod\n');
}
process.exitCode = failed ? 1 : 0;
