/**
 * The registration handler, end to end, against a stand-in database.
 *
 * These pin down the rules that keep a submitted value from reaching Google
 * Drive: a receipt has to be a file the app uploaded, and no path through the
 * handler deletes anything. Every test fails if a network call is made at all.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgres://stand-in';
process.env.GOOGLE_DRIVE_FOLDER_ID = 'FOLDER_ID_0123456789abcdefghij';
process.env.SITE_URL = 'https://run.example';
for (const k of ['GMAIL_USER', 'SMTP_PASSWORD', 'SHEET_ID', 'VERCEL']) delete process.env[k];

const { __setClient, __resetSchemaCheck } = await import('../lib/db.js');
const { __resetMemory } = await import('../lib/rate-limit.js');
const { deleteDriveFile } = await import('../lib/google-drive.js');
const { default: register } = await import('../api/register.js');

const FILE = 'DRIVE_FILE_ID_abcdefghijklmnopqrstu';

let db;
let network;

/** Answers the handful of statements the handler issues, and remembers them. */
function standInDatabase() {
  const state = { uploads: new Map(), registrations: [], failInsert: false };
  const client = async (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ');
    if (text.includes('to_regclass')) return [{ uploads: true, limits: true, privacy: true }];
    if (text.includes('INSERT INTO rate_limits')) return [{ count: 1 }];
    if (text.includes('DELETE FROM rate_limits')) return [];
    if (text.includes('UPDATE uploads SET reference = NULL')) {
      const [fileId, hold] = values;
      if (state.uploads.get(fileId) === hold) state.uploads.set(fileId, null);
      return [];
    }
    if (text.includes('UPDATE uploads') && text.includes('reference IS NULL')) {
      const [hold, fileId] = values;
      if (!state.uploads.has(fileId) || state.uploads.get(fileId) !== null) return [];
      state.uploads.set(fileId, hold);
      return [{ file_id: fileId }];
    }
    if (text.includes('UPDATE uploads')) {
      const [reference, fileId, hold] = values;
      if (state.uploads.get(fileId) === hold) state.uploads.set(fileId, reference);
      return [];
    }
    if (text.includes('INSERT INTO registrations')) {
      if (state.failInsert) throw new Error('relation "registrations" is on fire');
      const [reference, full_name, email, proof_url, answers] = values;
      state.registrations.push({ reference, full_name, email, proof_url, answers: JSON.parse(answers) });
      return [{ reference }];
    }
    if (text.includes('UPDATE registrations')) return [];
    throw new Error(`stand-in database has no answer for: ${text}`);
  };
  client.query = async () => [];
  return { client, state };
}

beforeEach(() => {
  db = standInDatabase();
  __setClient(db.client);
  __resetSchemaCheck();
  __resetMemory();
  network = [];
  globalThis.fetch = async (url) => { network.push(String(url)); throw new Error('no network in tests'); };
});

const answers = (over = {}) => ({
  full_name: 'Juan Dela Cruz',
  email_address: 'juan@example.com',
  contact_number: '+63 917 123 4567',
  age: '21',
  sex: 'Male',
  school_affiliation: 'Alumni',
  race_category: '5K',
  shirt_size: 'M',
  payment_method: 'Bank transfer',
  proof_of_payment: FILE,
  emergency_contact_name: 'Maria Dela Cruz',
  emergency_contact_number: '09171234567',
  waiver_agreed: true,
  privacy_agreed: true,
  _hp: '',
  ...over,
});

async function submit(body) {
  const out = { status: 0, json: null };
  const res = {
    setHeader() {},
    status(code) { out.status = code; return this; },
    json(obj) { out.json = obj; return this; },
  };
  await register({ method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9' }, body }, res);
  return out;
}

test('a receipt this app uploaded is accepted, and the server builds the stored link', async () => {
  db.state.uploads.set(FILE, null);
  const out = await submit(answers());

  assert.equal(out.status, 200);
  assert.equal(out.json.ok, true);
  const [row] = db.state.registrations;
  assert.equal(row.proof_url, `https://run.example/api/receipt?id=${FILE}`);
  assert.equal(row.answers['Proof of payment'], row.proof_url);
  assert.equal(db.state.uploads.get(FILE), row.reference, 'the upload now belongs to the registration');
  assert.deepEqual(network, []);
});

test('a link of the submitter\'s choosing is not a receipt', async () => {
  // The old hole: any https URL was accepted, and "?id=" chose what a failed
  // write would delete — the receipts folder itself included.
  const out = await submit(answers({
    proof_of_payment: `https://evil.example/?id=${process.env.GOOGLE_DRIVE_FOLDER_ID}`,
  }));

  assert.equal(out.status, 422);
  assert.equal(db.state.registrations.length, 0);
  assert.deepEqual(network, []);
});

test('a well-formed id the app never uploaded is refused', async () => {
  const out = await submit(answers({ proof_of_payment: process.env.GOOGLE_DRIVE_FOLDER_ID }));

  assert.equal(out.status, 422);
  assert.equal(out.json.uploadCleared, true);
  assert.equal(db.state.registrations.length, 0);
  assert.deepEqual(network, []);
});

test('the link a page from before this change still posts is understood', async () => {
  db.state.uploads.set(FILE, null);
  const out = await submit(answers({
    proof_of_payment: `https://drive.google.com/file/d/${FILE}/view?usp=sharing`,
  }));

  assert.equal(out.status, 200);
  assert.equal(db.state.registrations[0].proof_url, `https://run.example/api/receipt?id=${FILE}`);
});

test('one receipt cannot be used by a second registration', async () => {
  db.state.uploads.set(FILE, null);
  assert.equal((await submit(answers())).status, 200);
  assert.equal((await submit(answers({ full_name: 'Somebody Else' }))).status, 422);
  assert.equal(db.state.registrations.length, 1);
});

test('control characters are stripped rather than failing the write', async () => {
  db.state.uploads.set(FILE, null);
  const out = await submit(answers({ full_name: 'Juan\u0000 Dela\u0007 Cruz', medical_conditions: 'Asthma\r\nPeanuts\u0000' }));

  assert.equal(out.status, 200);
  const [row] = db.state.registrations;
  assert.equal(row.full_name, 'Juan Dela Cruz');
  assert.equal(row.answers['Medical conditions or allergies'], 'Asthma\r\nPeanuts');
});

test('a failed write deletes nothing, leaks nothing, and frees the receipt', async () => {
  db.state.uploads.set(FILE, null);
  db.state.failInsert = true;
  const out = await submit(answers());

  assert.equal(out.status, 502);
  assert.equal(out.json.detail, undefined, 'the database error stays in the logs');
  assert.ok(!JSON.stringify(out.json).includes('on fire'));
  assert.equal(db.state.uploads.get(FILE), null, 'the runner can submit again with the same file');
  assert.deepEqual(network, [], 'nothing was sent to Google Drive');

  db.state.failInsert = false;
  assert.equal((await submit(answers())).status, 200);
});

test('an employee on salary deduction registers without a receipt', async () => {
  const out = await submit(answers({
    payment_method: 'Employee',
    proof_of_payment: `https://evil.example/?id=${process.env.GOOGLE_DRIVE_FOLDER_ID}`,
    sd_full_name: 'Juan Dela Cruz',
    sd_employee_number: '2019-0431',
    sd_department: 'Alumni Department',
    sd_authorization: 'DELA CRUZ, JUAN',
  }));

  assert.equal(out.status, 200);
  assert.equal(db.state.registrations[0].proof_url, '', 'a question that was not asked is stored blank');
});

test('both confirmations are required', async () => {
  db.state.uploads.set(FILE, null);
  assert.equal((await submit(answers({ waiver_agreed: false }))).status, 422);
  assert.equal((await submit(answers({ privacy_agreed: undefined }))).status, 422);
  assert.equal(db.state.uploads.get(FILE), null, 'a rejected form does not use up the receipt');
});

test('deleteDriveFile takes a bare file id and never the receipts folder', async () => {
  assert.equal(await deleteDriveFile(`https://evil.example/?id=${FILE}`), false);
  assert.equal(await deleteDriveFile(process.env.GOOGLE_DRIVE_FOLDER_ID), false);
  assert.equal(await deleteDriveFile(''), false);
  assert.deepEqual(network, []);
});
