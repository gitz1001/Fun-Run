/**
 * Receipts too big for a function go to Drive directly. These pin down what
 * keeps that safe: the server decides the file's name, type and size; only a
 * file with exactly that name, in the receipts folder, of that size and that
 * real type is recorded; and nothing it did not create is ever deleted.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL = 'postgres://stand-in';
process.env.GOOGLE_DRIVE_FOLDER_ID = 'FOLDER_ID_0123456789abcdefghij';
Object.assign(process.env, { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REFRESH_TOKEN: 'token' });

const { __setClient, __resetSchemaCheck } = await import('../lib/db.js');
const { __resetMemory } = await import('../lib/rate-limit.js');
const { __resetTokenCache } = await import('../lib/google-auth.js');
const uploads = await import('../lib/uploads.js');
const { default: session } = await import('../api/upload-session.js');

const FOLDER = process.env.GOOGLE_DRIVE_FOLDER_ID;
const FILE = 'DRIVE_FILE_ID_abcdefghijklmnopqrstu';
const BIG = 6 * 1024 * 1024;
const PDF_HEAD = Buffer.from('%PDF-1.7\n%âãÏÓ\n12345');

let recorded;
let drive;     // what the stand-in Drive holds for FILE
let calls;

beforeEach(() => {
  recorded = new Set();
  calls = [];
  drive = null;
  __resetSchemaCheck();
  __resetMemory();
  __resetTokenCache();
  const client = async (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ');
    if (text.includes('to_regclass')) return [{ uploads: true, limits: true, privacy: true, submission: true }];
    if (text.includes('INSERT INTO rate_limits')) return [{ count: 1 }];
    if (text.includes('FROM uploads WHERE file_id')) return recorded.has(values[0]) ? [{ known: 1 }] : [];
    if (text.includes('INSERT INTO uploads')) { recorded.add(values[0]); return []; }
    throw new Error(`stand-in database has no answer for: ${text}`);
  };
  client.query = async () => [];
  __setClient(client);

  const json = (body, init = {}) => new Response(JSON.stringify(body), {
    status: 200, ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const headers = new Headers(options.headers || {});
    calls.push({ method: options.method || 'GET', url: u, headers, body: options.body });
    if (u.includes('oauth2.googleapis.com/token')) return json({ access_token: 'access', expires_in: 3600 });
    if (u.includes('uploadType=resumable')) {
      return new Response(null, { status: 200, headers: { Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=XYZ' } });
    }
    if (u.includes(`/files/${FILE}`) && options.method === 'DELETE') { drive = null; return new Response(null, { status: 204 }); }
    if (u.includes(`/files/${FILE}`) && u.includes('alt=media')) return new Response(drive.head);
    if (u.includes(`/files/${FILE}`)) {
      if (!drive) return new Response('{}', { status: 404 });
      return json({ id: FILE, name: drive.name, mimeType: drive.type, size: String(drive.size), parents: drive.parents, trashed: false });
    }
    return new Response('{}', { status: 404 });
  };
});

async function call(body, headers = { origin: 'https://funrun.example', host: 'funrun.example' }) {
  const out = { status: 0, json: null };
  const res = {
    setHeader() {},
    status(code) { out.status = code; return this; },
    json(obj) { out.json = obj; return this; },
  };
  await session({ method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9', ...headers }, body }, res);
  return out;
}

const start = (over = {}) => call({ action: 'start', type: 'application/pdf', size: BIG, name: 'bank slip.pdf', ...over });

test('the page and the server agree on the size limits', () => {
  const page = readFileSync(new URL('../public/receipt-upload.js', import.meta.url), 'utf8');
  const mb = (name) => Number(page.match(new RegExp(`export const ${name} = (\\d+) \\* 1024 \\* 1024`))?.[1]);
  assert.equal(mb('MAX_UPLOAD') * 1024 * 1024, uploads.MAX_BYTES);
  assert.equal(mb('PROXY_MAX') * 1024 * 1024, uploads.PROXY_MAX_BYTES);
  // Vercel refuses a function body over 4.5 MB: the proxied route must stay under it.
  assert.ok(uploads.PROXY_MAX_BYTES < 4.5 * 1024 * 1024);
});

test('a ticket cannot be altered, and does not last', () => {
  const t = uploads.signTicket({ name: 'n', type: 'application/pdf', size: BIG });
  assert.deepEqual(uploads.readTicket(t), { name: 'n', type: 'application/pdf', size: BIG });
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), n: 'other' })).toString('base64url');
  assert.equal(uploads.readTicket(`${forged}.${sig}`), null);
  assert.equal(uploads.readTicket(t, Date.now() + 3 * 60 * 60 * 1000), null);
  assert.equal(uploads.readTicket('garbage'), null);
});

test('a session is opened for a large file, for this page only', async () => {
  const out = await start();
  assert.equal(out.status, 200, JSON.stringify(out.json));
  assert.match(out.json.uploadUrl, /^https:\/\/www\.googleapis\.com\/upload\//);
  const opened = calls.find((c) => c.url.includes('uploadType=resumable'));
  assert.equal(opened.headers.get('origin'), 'https://funrun.example');
  assert.equal(opened.headers.get('x-upload-content-length'), String(BIG));
  const meta = JSON.parse(opened.body);
  assert.deepEqual(meta.parents, [FOLDER]);
  assert.equal(uploads.readTicket(out.json.ticket).name, meta.name);
});

test('a session is refused for the wrong size, type or site', async () => {
  assert.equal((await start({ size: 11 * 1024 * 1024 })).status, 413);
  assert.equal((await start({ size: 1024 })).status, 400);
  assert.equal((await start({ type: 'text/html' })).status, 415);
  assert.equal((await call({ action: 'start', type: 'application/pdf', size: BIG },
    { origin: 'https://evil.example', host: 'funrun.example' })).status, 403);
  assert.ok(!calls.some((c) => c.url.includes('uploadType=resumable')));
});

test('the uploaded file is checked, then recorded once', async () => {
  const { json: s } = await start();
  const name = uploads.readTicket(s.ticket).name;
  drive = { name, type: 'application/pdf', size: BIG, parents: [FOLDER], head: PDF_HEAD };
  const out = await call({ action: 'finish', id: FILE, ticket: s.ticket });
  assert.equal(out.status, 200, JSON.stringify(out.json));
  assert.ok(recorded.has(FILE));
  // Asking again is answered the same way, without another look.
  assert.equal((await call({ action: 'finish', id: FILE, ticket: s.ticket })).status, 200);
});

test('a file this session did not make is neither recorded nor deleted', async () => {
  const { json: s } = await start();
  drive = { name: 'someone-elses-receipt.pdf', type: 'application/pdf', size: BIG, parents: [FOLDER], head: PDF_HEAD };
  assert.equal((await call({ action: 'finish', id: FILE, ticket: s.ticket })).status, 400);
  assert.ok(!recorded.has(FILE));
  assert.ok(!calls.some((c) => c.method === 'DELETE'));
});

test('a file that is not what it claimed is deleted', async () => {
  const { json: s } = await start();
  const name = uploads.readTicket(s.ticket).name;
  drive = { name, type: 'application/pdf', size: BIG, parents: [FOLDER], head: Buffer.from('<html><script>…') };
  assert.equal((await call({ action: 'finish', id: FILE, ticket: s.ticket })).status, 415);
  assert.ok(!recorded.has(FILE));
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes(FILE)));
});
