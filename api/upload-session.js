import {
  driveConfigured, startResumableUpload, getDriveFileInfo, readDriveHead, deleteDriveFile,
} from '../lib/google-drive.js';
import { dbConfigured, ensureSchema, recordUpload, uploadKnown } from '../lib/db.js';
import { limited, clientIp } from '../lib/rate-limit.js';
import {
  ALLOWED, MAX_BYTES, MAX_MB, PROXY_MAX_BYTES, SNIFF_BYTES, UPLOAD_LIMIT,
  sniff, storedName, newNonce, signTicket, readTicket,
} from '../lib/uploads.js';

/**
 * Receipts too big to pass through a function (over 4 MB) go to Google Drive
 * straight from the browser, in two steps around the transfer itself:
 *
 *   POST { action: "start", type, size, name }
 *        -> { uploadUrl, ticket }   the browser PUTs the file to uploadUrl
 *   POST { action: "finish", id, ticket }
 *        -> { ok, id, size }        the file is checked, then recorded
 *
 * Only "finish" puts a file in the uploads table, and it does so only after
 * reading the file back from Drive: the name must be the one this server gave
 * it, it must sit in the receipts folder, its size must match what was
 * declared, and its first bytes must be the type that was declared. A file
 * that fails is deleted — safe, because its name proves this session made it.
 *
 * Small receipts still go through /api/drive-upload, unchanged.
 */

const FINISH_LIMIT = { windowSec: 60 * 60, max: 120 };

/** The page's own origin, which Google will allow to send the bytes. */
function pageOrigin(req) {
  const origin = String(req.headers.origin || '');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  if (!origin || !host) return '';
  try {
    // Only the site's own page: a session opened from anywhere else would
    // have Google accept the upload from that other site.
    return new URL(origin).host === host ? origin : '';
  } catch { return ''; }
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 8 * 1024) throw new Error('TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const tooBig = `That file is too large. Please keep it under ${MAX_MB} MB.`;

async function start(req, res, body, ip) {
  const type = String(body.type || '').toLowerCase();
  const size = Number(body.size);
  if (!ALLOWED[type]) {
    return res.status(415).json({ ok: false, error: 'Please upload a JPG, PNG, WEBP or HEIC photo, or a PDF.' });
  }
  if (!Number.isInteger(size) || size < 1) {
    return res.status(400).json({ ok: false, error: 'The file to upload was empty.' });
  }
  if (size > MAX_BYTES) return res.status(413).json({ ok: false, error: tooBig });
  // Small files have the simpler route, and keep to it.
  if (size <= PROXY_MAX_BYTES) {
    return res.status(400).json({ ok: false, error: 'Small files are uploaded through /api/drive-upload.' });
  }
  const origin = pageOrigin(req);
  if (!origin) return res.status(403).json({ ok: false, error: 'Uploads are only accepted from the registration page.' });

  if (await limited('upload', ip, UPLOAD_LIMIT)) {
    return res.status(429).json({ ok: false, error: 'Too many uploads from this connection. Please wait a while and try again.' });
  }

  const name = storedName(body.name, newNonce());
  let uploadUrl;
  try {
    uploadUrl = await startResumableUpload({ filename: name, contentType: type, size, origin });
  } catch (err) {
    console.error('[upload-session] could not open a session:', err?.message || err);
    return res.status(500).json({ ok: false, error: 'Could not start the upload. Please try again.' });
  }
  return res.status(200).json({ ok: true, uploadUrl, ticket: signTicket({ name, type, size }) });
}

async function finish(req, res, body, ip) {
  const ticket = readTicket(body.ticket);
  const id = String(body.id || '');
  if (!ticket || !/^[A-Za-z0-9_-]{10,200}$/.test(id)) {
    return res.status(400).json({ ok: false, error: 'That upload could not be confirmed. Please choose the file again.' });
  }
  if (await limited('upload-finish', ip, FINISH_LIMIT)) {
    return res.status(429).json({ ok: false, error: 'Too many uploads from this connection. Please wait a while and try again.' });
  }

  try {
    await ensureSchema();
    // A page that lost the answer and asks again gets the same one.
    if (await uploadKnown(id)) return res.status(200).json({ ok: true, id, size: ticket.size });

    const info = await getDriveFileInfo(id);
    // Not the file this session made: say nothing more, delete nothing.
    if (!info || info.trashed || !info.inFolder || info.name !== ticket.name) {
      return res.status(400).json({ ok: false, error: 'That upload could not be confirmed. Please choose the file again.' });
    }

    const head = info.size === ticket.size ? await readDriveHead(id, SNIFF_BYTES) : null;
    if (!head || sniff(head) !== ALLOWED[ticket.type]) {
      await deleteDriveFile(id).catch((e) => console.error('[upload-session] cleanup failed:', e.message));
      return res.status(415).json({ ok: false, error: 'That file does not look like a valid image or PDF.' });
    }

    await recordUpload(id, ip);
  } catch (err) {
    console.error('[upload-session] could not confirm the upload:', err?.message || err);
    return res.status(500).json({ ok: false, error: 'Could not store the file. Please try again.' });
  }

  console.log(`[upload-session] stored ${ticket.name} (${ticket.size} bytes) as ${id}`);
  return res.status(200).json({ ok: true, id, size: ticket.size, contentType: ticket.type });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  res.setHeader('Cache-Control', 'no-store');

  if (!driveConfigured() || !dbConfigured()) {
    return res.status(503).json({ ok: false, error: 'File uploads are not set up yet. Please contact the organisers.' });
  }

  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ ok: false, error: 'Could not read the request.' }); }

  const ip = clientIp(req);
  if (body?.action === 'start') return start(req, res, body, ip);
  if (body?.action === 'finish') return finish(req, res, body, ip);
  return res.status(400).json({ ok: false, error: 'Unknown upload step.' });
}
