import { randomBytes } from 'node:crypto';
import {
  FORM, validate, isActive, cleanAnswer, AGREEMENT, PRIVACY, waiverState, privacyState,
} from '../lib/form-schema.js';
import { appendRegistration } from '../lib/sheets.js';
import { sendConfirmation, explainMailError, missingEnv } from '../lib/mailer.js';
import { confirmationHtml, confirmationText } from '../lib/template.js';
import {
  dbConfigured, ensureSchema, saveRegistration, markSheetSynced, markEmailSent,
  holdUpload, settleUpload, releaseUpload, uploadKnown, recordUpload, receiptAlreadyUsed,
} from '../lib/db.js';
import { driveConfigured, receiptInFolder } from '../lib/google-drive.js';
import { afterResponse } from '../lib/after-response.js';
import { receiptFileId, receiptLink } from '../lib/receipts.js';
import { limited, clientIp } from '../lib/rate-limit.js';

const APP_NAME = process.env.APP_NAME || 'Southville Run For A Cause 2026';

// Generous on purpose: a whole school registers from behind one campus address.
const SUBMISSIONS = { windowSec: 60, max: 20 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const ip = clientIp(req);
  if (await limited('register', ip, SUBMISSIONS)) {
    return res.status(429).json({ ok: false, error: 'Too many submissions. Please wait a minute.' });
  }

  const raw = typeof req.body === 'string' ? safeJson(req.body) : req.body || {};
  const sent = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  // Honeypot: real people leave this hidden field empty.
  if (typeof sent._hp === 'string' && sent._hp.trim() !== '') {
    return res.status(200).json({ ok: true, ref: 'IGNORED' });
  }

  // Every answer is cleaned once, here, and everything below — validation,
  // the conditional rules, the database — reads the cleaned copy.
  const body = { ...sent };
  for (const f of FORM.fields) body[f.name] = cleanAnswer(f, sent[f.name]);

  const errors = validate(body);
  if (errors.length) {
    return res.status(422).json({ ok: false, errors });
  }

  // Conditional questions that were not asked are stored blank, so a runner
  // who tried "Employee", filled the salary-deduction panel, then switched
  // back to a bank transfer cannot leave stale payroll details in the sheet
  // or email — and an employee's registration never carries a receipt.
  const values = {};
  for (const f of FORM.fields) {
    values[f.name] = isActive(f, body) ? body[f.name] : '';
  }

  if (!dbConfigured()) {
    console.error('[register] no DATABASE_URL configured');
    return res.status(503).json({
      ok: false,
      error: 'Registrations are not open yet. Please contact the organisers.',
    });
  }

  // --- 1. the receipt has to be one this app uploaded ----------------
  // The page sends a Drive file id. It is taken only if the uploads table
  // lists it and no other registration has it; what gets stored is a link
  // the server builds itself. Nothing the browser sent is used as a link,
  // and nothing here ever deletes from Drive.
  const hold = `hold:${randomBytes(9).toString('hex')}`;
  const held = [];
  try {
    await ensureSchema();
    for (const f of FORM.fields) {
      if (f.type !== 'file' || !values[f.name]) continue;
      const fileId = receiptFileId(values[f.name]);
      if (!fileId || !(await takeUpload(fileId, hold, ip))) {
        await releaseAll(held, hold);
        return res.status(422).json({
          ok: false,
          errors: [`${f.label} must be uploaded before submitting.`],
          uploadCleared: true,
        });
      }
      held.push(fileId);
      values[f.name] = receiptLink(fileId);
    }
  } catch (err) {
    console.error('[register] could not check the upload:', err.message);
    await releaseAll(held, hold);
    return res.status(502).json({
      ok: false,
      error: 'We could not record your registration, so no email was sent. Please try again.',
    });
  }

  const when = new Date().toLocaleString('en-PH', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Asia/Manila',
  });
  // validate() has already required both confirmations.
  const agreed = waiverState(body);
  const privacy = privacyState(body);

  // Carried as an answer as well as a column: that is what puts it in the
  // sheet, the confirmation email and the dashboard's detail view. Left blank
  // when nothing was stated, so the row never claims an acceptance it did not
  // receive.
  const answers = FORM.fields.map((f) => [f.label, values[f.name]]);
  answers.push([AGREEMENT.label, agreed === true ? AGREEMENT.agreed : '']);
  answers.push([PRIVACY.label, privacy === true ? PRIVACY.agreed : '']);
  const labelled = Object.fromEntries(answers);

  // --- 2. record the registration — the database decides -------------
  // Postgres is the source of truth. If this fails, nobody is registered and
  // nothing is emailed. The receipt is let go rather than deleted, so the
  // runner can press submit again without attaching it a second time.
  let ref;
  try {
    ({ reference: ref } = await saveRegistration({ values, labelled, ip, agreed, privacy }));
  } catch (err) {
    console.error('[register] database write failed:', err.message);
    await releaseAll(held, hold);
    return res.status(502).json({
      ok: false,
      error: 'We could not record your registration, so no email was sent. Please try again.',
    });
  }

  for (const fileId of held) {
    await settleUpload(fileId, hold, ref)
      .catch((err) => console.error(`[register] ${ref}: could not settle upload ${fileId}:`, err.message));
  }

  // --- 3. answer the runner now --------------------------------------
  // They are registered the moment the database write succeeded. Making them
  // wait ~10s while we talk to Sheets and Gmail is needless — those run after
  // the response, kept alive by waitUntil so the platform cannot cut them off.
  const to = values[FORM.emailField];
  const name = values[FORM.nameField] || to;
  const miss = missingEnv();

  res.status(200).json({
    ok: true,
    ref,
    mailSent: false,
    mailQueued: miss.length === 0,
    mailError: miss.length ? 'Registration saved, but the confirmation email is not set up yet.' : undefined,
  });

  // --- 4. sheet mirror + confirmation email, after responding ---------
  await afterResponse(async () => {
    try {
      const mirrored = await appendRegistration({ reference: ref, labelled });
      await markSheetSynced(ref, mirrored.ok, mirrored.error).catch(() => {});
      if (!mirrored.ok) console.error('[register] sheet mirror failed:', mirrored.error);
    } catch (err) {
      console.error('[register] sheet mirror threw:', err.message);
      await markSheetSynced(ref, false, err.message).catch(() => {});
    }

    if (miss.length) {
      console.error('[register] mail not configured:', miss.join(', '));
      await markEmailSent(ref, false, `not configured: missing ${miss.join(', ')}`).catch(() => {});
      return;
    }

    try {
      await sendConfirmation({
        to,
        name,
        subject: `Registration confirmed — ${APP_NAME}`,
        html: confirmationHtml({ answers, appName: APP_NAME, ref, when }),
        text: confirmationText({ answers, appName: APP_NAME, ref, when }),
      });
      await markEmailSent(ref, true).catch(() => {});
      console.log(`[register] ${ref} emailed to ${to}`);
    } catch (err) {
      const explained = explainMailError(err);
      console.error('[register] mail failed:', explained);
      // Never lost: the row records why, and "npm run replay" resends it.
      await markEmailSent(ref, false, explained).catch(() => {});
    }
  });
}

/**
 * Takes the upload for this registration.
 *
 * Normally that is one statement against the uploads table. The exception is
 * a runner who attached their receipt just before that table existed and
 * pressed submit just after: the file is real, but nothing recorded it. It is
 * recognised by asking Drive whether the id is a file in the receipts folder,
 * and only when no registration has used it — then it is recorded and taken
 * like any other. If Drive cannot be asked, the answer is no and the runner
 * is asked to attach it again, which is all that would have happened anyway.
 */
async function takeUpload(fileId, hold, ip) {
  if (await holdUpload(fileId, hold)) return true;
  if (await uploadKnown(fileId)) return false;            // known, and already used
  if (!driveConfigured() || (await receiptAlreadyUsed(fileId))) return false;
  const there = await receiptInFolder(fileId).catch((err) => {
    console.error('[register] could not check an unrecorded upload:', err.message);
    return false;
  });
  if (!there) return false;
  await recordUpload(fileId, ip);
  return holdUpload(fileId, hold);
}

async function releaseAll(held, hold) {
  for (const fileId of held) {
    await releaseUpload(fileId, hold)
      .catch((err) => console.error(`[register] could not release upload ${fileId}:`, err.message));
  }
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
