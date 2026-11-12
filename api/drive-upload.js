import { uploadToDrive, deleteDriveFile, driveConfigured } from '../lib/google-drive.js';
import { dbConfigured, ensureSchema, recordUpload } from '../lib/db.js';
import { limited, clientIp } from '../lib/rate-limit.js';
import {
  ALLOWED, PROXY_MAX_BYTES, MAX_MB, UPLOAD_LIMIT, sniff, storedName,
} from '../lib/uploads.js';

// The cap for this route is Vercel's, not ours: a function refuses any
// request body over 4.5 MB before this code runs. Larger receipts, up to
// MAX_BYTES, go straight to Drive through /api/upload-session instead.
const MAX_BYTES = PROXY_MAX_BYTES;
const tooBig = `That file is too large. Please keep it under ${MAX_MB} MB.`;

async function readBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'binary');
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BYTES + 1024) throw new Error('TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  res.setHeader('Cache-Control', 'no-store');

  const ip = clientIp(req);
  if (await limited('upload', ip, UPLOAD_LIMIT)) {
    return res.status(429).json({ ok: false, error: 'Too many uploads from this connection. Please wait a while and try again.' });
  }
  // The uploads table is what lets a registration name this file later, so
  // without a database there is nothing useful an upload could lead to.
  if (!driveConfigured() || !dbConfigured()) {
    return res.status(503).json({ ok: false, error: 'File uploads are not set up yet. Please contact the organisers.' });
  }

  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED[contentType]) {
    return res.status(415).json({ ok: false, error: 'Please upload a JPG, PNG, WEBP or HEIC photo, or a PDF.' });
  }

  let buf;
  try { buf = await readBody(req); }
  catch (err) {
    if (err.message === 'TOO_LARGE') return res.status(413).json({ ok: false, error: tooBig });
    return res.status(400).json({ ok: false, error: 'Could not read the uploaded file.' });
  }
  if (!buf.length) return res.status(400).json({ ok: false, error: 'The uploaded file was empty.' });
  if (buf.length > MAX_BYTES) return res.status(413).json({ ok: false, error: tooBig });

  if (sniff(buf) !== ALLOWED[contentType]) {
    return res.status(415).json({ ok: false, error: 'That file does not look like a valid image or PDF.' });
  }

  const filename = storedName(req.headers['x-filename']);

  let file;
  try {
    await ensureSchema();
    file = await uploadToDrive({ buffer: buf, filename, contentType });
  } catch (err) {
    // Google's own wording stays in the logs. "npm run doctor" and the staff
    // health check are where a configuration problem is meant to be read.
    console.error('[drive-upload] upload failed:', err?.message || err);
    return res.status(500).json({ ok: false, error: 'Could not store the file. Please try again.' });
  }

  try {
    await recordUpload(file.id, ip);
  } catch (err) {
    // Unrecorded, the file could never be registered with. It was created a
    // moment ago by this request, so removing it here is safe.
    console.error('[drive-upload] could not record the upload:', err.message);
    await deleteDriveFile(file.id).catch((e) => console.error('[drive-upload] cleanup failed:', e.message));
    return res.status(500).json({ ok: false, error: 'Could not store the file. Please try again.' });
  }

  console.log(`[drive-upload] stored ${file.name} (${buf.length} bytes) as ${file.id}`);
  return res.status(200).json({
    ok: true,
    id: file.id,
    name: file.name,
    size: buf.length,
    contentType,
  });
}
