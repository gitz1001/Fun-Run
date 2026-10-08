import { uploadToDrive, deleteDriveFile, driveConfigured } from '../lib/google-drive.js';
import { dbConfigured, ensureSchema, recordUpload } from '../lib/db.js';
import { limited, clientIp } from '../lib/rate-limit.js';

const MAX_BYTES = 4 * 1024 * 1024;
// Photos are shrunk in the browser first: to WebP where it can encode one,
// and to JPEG where it cannot — which is every browser on an iPhone. This
// used to accept WebP alone, so no iPhone could attach a photo at all. PNG
// and HEIC are what arrives when the browser could not re-encode the picture.
const ALLOWED = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
  'image/heic': 'heic',
  'image/heif': 'heic',
};
// The brands an ISO media file declares when it is a HEIC/HEIF still image.
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1', 'heif']);

// Generous on purpose: a whole school registers from behind one campus address.
const UPLOADS = { windowSec: 60 * 60, max: 60 };

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniff(buf) {
  if (buf.length > 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
      buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.length > 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp' &&
      HEIC_BRANDS.has(buf.subarray(8, 12).toString('latin1'))) return 'heic';
  return null;
}

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

// The page percent-encodes the name, since a header can only carry Latin-1.
// A page from before that sends it raw, and a raw name may not decode.
const decoded = (s) => { try { return decodeURIComponent(String(s || '')); } catch { return String(s || ''); } };

const safeName = (s) => (decoded(s) || 'receipt')
  .replace(/[^a-zA-Z0-9._-]/g, '_')
  .replace(/_{2,}/g, '_')
  .slice(-80) || 'receipt';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  res.setHeader('Cache-Control', 'no-store');

  const ip = clientIp(req);
  if (await limited('upload', ip, UPLOADS)) {
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
    if (err.message === 'TOO_LARGE') return res.status(413).json({ ok: false, error: 'That file is too large. Please keep it under 4 MB.' });
    return res.status(400).json({ ok: false, error: 'Could not read the uploaded file.' });
  }
  if (!buf.length) return res.status(400).json({ ok: false, error: 'The uploaded file was empty.' });
  if (buf.length > MAX_BYTES) return res.status(413).json({ ok: false, error: 'That file is too large. Please keep it under 4 MB.' });

  if (sniff(buf) !== ALLOWED[contentType]) {
    return res.status(415).json({ ok: false, error: 'That file does not look like a valid image or PDF.' });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `${stamp}-${safeName(req.headers['x-filename'])}`;

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
