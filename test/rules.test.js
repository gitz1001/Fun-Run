/** The pure rules: validation, receipt ids, CSV cells, reference codes, the email. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FORM, validate, cleanAnswer, maxLengthOf } from '../lib/form-schema.js';
import { receiptFileId, receiptLink, isReceiptLink } from '../lib/receipts.js';
import { newReference, normaliseReference } from '../lib/reference.js';
import { confirmationHtml, confirmationText } from '../lib/template.js';
import { headerRow } from '../lib/sheets.js';
import { csvCell } from '../public/csv.js';

const ID = 'DRIVE_FILE_ID_abcdefghijklmnopqrstu';

const valid = (over = {}) => ({
  full_name: 'Juan Dela Cruz',
  email_address: 'juan@example.com',
  contact_number: '09171234567',
  age: '21',
  sex: 'Male',
  school_affiliation: 'Alumni',
  race_category: '5K',
  shirt_size: 'M',
  payment_method: 'Bank transfer',
  proof_of_payment: ID,
  emergency_contact_name: 'Maria Dela Cruz',
  emergency_contact_number: '09171234567',
  waiver_agreed: true,
  privacy_agreed: true,
  ...over,
});

test('a complete form passes', () => {
  assert.deepEqual(validate(valid()), []);
});

test('every text question has a length limit, and it is enforced', () => {
  for (const f of FORM.fields) assert.ok(maxLengthOf(f) > 0, f.name);
  assert.match(validate(valid({ team_or_organization: 'x'.repeat(121) })).join(' '), /Team \/ Organization is too long/);
  assert.match(validate(valid({ medical_conditions: 'x'.repeat(1001) })).join(' '), /too long/);
});

test('proof of payment has to be a file id, not just any link', () => {
  assert.match(validate(valid({ proof_of_payment: 'https://evil.example/receipt.png' })).join(' '), /must be uploaded/);
  assert.match(validate(valid({ proof_of_payment: 'short' })).join(' '), /must be uploaded/);
});

test('cleanAnswer drops control characters and keeps line breaks only in paragraphs', () => {
  const short = FORM.fields.find((f) => f.name === 'full_name');
  const para = FORM.fields.find((f) => f.type === 'paragraph');
  assert.equal(cleanAnswer(short, '  Juan\u0000\tDela\nCruz  '), 'Juan Dela Cruz');
  assert.equal(cleanAnswer(para, 'one\ntwo\u0000'), 'one\ntwo');
  assert.equal(cleanAnswer(short, 42), '');
});

test('receiptFileId reads the three spellings and nothing else', () => {
  assert.equal(receiptFileId(ID), ID);
  assert.equal(receiptFileId(`https://drive.google.com/file/d/${ID}/view?usp=sharing`), ID);
  assert.equal(receiptFileId(`https://run.example/api/receipt?id=${ID}`), ID);
  assert.equal(receiptFileId(`/api/receipt?id=${ID}`), ID);
  assert.equal(receiptFileId(`https://evil.example/?id=${ID}`), '');
  assert.equal(receiptFileId(`https://drive.google.com.evil.example/file/d/${ID}/view`), '');
  assert.equal(receiptFileId('https://evil.example/'), '');
  assert.equal(receiptFileId(''), '');
});

test('receiptLink round-trips, and only receipt links count as receipts', () => {
  const link = receiptLink(ID);
  assert.equal(link, `https://drive.google.com/file/d/${ID}/view?usp=sharing`);
  assert.equal(receiptFileId(link), ID);
  assert.ok(isReceiptLink(link));
  assert.ok(!isReceiptLink('https://evil.example/login'));
});

test('csvCell quotes everything and defuses formulas, but leaves phone numbers alone', () => {
  assert.equal(csvCell('Las Piñas'), '"Las Piñas"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("http://evil")'), '"\'=HYPERLINK(""http://evil"")"');
  assert.equal(csvCell('@SUM(A1)'), '"\'@SUM(A1)"');
  assert.equal(csvCell('+cmd|calc'), '"\'+cmd|calc"');
  assert.equal(csvCell('-2+3'), '"\'-2+3"');
  assert.equal(csvCell('+63 917 123 4567'), '"+63 917 123 4567"');
  assert.equal(csvCell(null), '""');
});

test('reference codes survive being typed back by a human', () => {
  const ref = newReference();
  assert.match(ref, /^SFO-[2-9A-HJKMNP-TV-Z]{6}$/);
  assert.equal(normaliseReference(ref.toLowerCase().replace('-', ' ')), ref);
  assert.equal(normaliseReference(ref.slice(4)), ref);
  assert.equal(normaliseReference('SFO-0O1IL'), null);
});

test('the confirmation email escapes answers and never links one', () => {
  const answers = [
    ['Full name', '<img src=x onerror=alert(1)>'],
    ['Team / Organization', 'https://evil.example/login'],
    ['Proof of payment', `https://run.example/api/receipt?id=${ID}`],
    ['Medical conditions or allergies', 'Asthma'],
  ];
  const html = confirmationHtml({ answers, appName: 'Run', ref: 'SFO-4K7M2X', when: 'today' });
  const text = confirmationText({ answers, appName: 'Run', ref: 'SFO-4K7M2X', when: 'today' });

  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<a '), 'no answer is turned into a link');
  assert.ok(!html.includes(ID) && !text.includes(ID), 'the staff-only receipt link stays out of the email');
  assert.match(html, /Proof of payment<\/td>\s*<td[^>]*>Received</);
  assert.match(text, /Proof of payment: Received/);
  // The runner's own answers are sent back to them in full.
  assert.match(html, /Asthma/);
  assert.match(text, /Medical conditions or allergies: Asthma/);
});

test('the Sheet carries both confirmations', () => {
  const header = headerRow();
  assert.ok(header.includes('Waiver of Liability'));
  assert.ok(header.includes('Data Privacy Consent'));
});
