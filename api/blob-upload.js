import { uploadReceipt, driveConfigured } from '../lib/google-drive.js';

/**
 * Compatibility endpoint retained at /api/blob-upload so the browser does not
 * need a second upload protocol. Storage is now Google Drive, not Vercel Blob.
 * Images have already been normalised to WebP in the browser.
 */
const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED = {
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

const SIGNATURES = [
  { ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
];

function sniff(buf) {
  for (const sig of SIGNATURES) {
    if (sig.bytes.every((b, i) => buf[i] === b)) return sig.ext;
  }
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF'
      && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
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

const safeName = (s) => String(s || 'receipt')
  .replace(/[^a-zA-Z0-9._-]/g, '_')
  .replace(/_{2,}/g, '_')
  .slice(-80) || 'receipt';

const UPLOADS_PER_HOUR = 12;
const uploads = new Map();
function uploadThrottled(ip) {
  const now = Date.now();
  const recent = (uploads.get(ip) || []).filter((t) => now - t < 60 * 60_000);
  recent.push(now);
  uploads.set(ip, recent);
  if (uploads.size > 500) uploads.clear();
  return recent.length > UPLOADS_PER_HOUR;
}

export function receiptUrl(req, fileId) {
  const base =
    process.env.SITE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`) ||
    (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`) ||
    `http://${req.headers?.host || 'localhost:3000'}`;
  return `${base.replace(/\/+$/, '')}/api/receipt?p=${encodeURIComponent(fileId)}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  res.setHeader('Cache-Control', 'no-store');

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (uploadThrottled(ip)) {
    return res.status(429).json({ ok: false, error: 'Too many uploads from this connection. Please wait a while and try again.' });
  }

  if (!driveConfigured()) {
    return res.status(503).json({ ok: false, error: 'File uploads are not configured yet. Please contact the organisers.' });
  }

  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED[contentType]) {
    return res.status(415).json({ ok: false, error: 'Please upload a JPG, PNG, WEBP or PDF file.' });
  }

  let buf;
  try {
    buf = await readBody(req);
  } catch (err) {
    if (err.message === 'TOO_LARGE') return res.status(413).json({ ok: false, error: 'That file is too large. Please keep it under 4 MB.' });
    return res.status(400).json({ ok: false, error: 'Could not read the uploaded file.' });
  }
  if (!buf.length) return res.status(400).json({ ok: false, error: 'The uploaded file was empty.' });
  if (buf.length > MAX_BYTES) return res.status(413).json({ ok: false, error: 'That file is too large. Please keep it under 4 MB.' });

  const actual = sniff(buf);
  const declared = ALLOWED[contentType];
    if (contentType === 'image/heic' || contentType === 'image/heif') { /* Skip strict signature check for HEIC/HEIF due to ftyp box complexity */ } else
  if (!actual || actual !== declared) {
    return res.status(415).json({ ok: false, error: 'That file does not look like a valid image or PDF.' });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const original = safeName(req.headers['x-filename']);
  const ext = contentType === 'image/webp' ? '.webp' : (contentType.startsWith('image/hei') ? '.heic' : '.pdf');
  const base = original.replace(/\.(webp|pdf|jpg|jpeg|png)$/i, '');
  const filename = `proof-of-payment-${stamp}-${base}${ext}`;

  try {
    const file = await uploadReceipt(buf, filename, contentType);
    console.log(`[drive-upload] stored ${file.id} (${buf.length} bytes)`);
    return res.status(200).json({
      ok: true,
      url: receiptUrl(req, file.id),
      fileId: file.id,
      name: file.name,
      size: buf.length,
      mimeType: file.mimeType || contentType,
    });
  } catch (err) {
    console.error('[drive-upload] upload failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Could not store the file. Please try again.' });
  }
}

/** Backward-compatible names used by register.js during the migration. */
export function pathnameFrom(value) {
  const raw = String(value || '').trim();
  try {
    const u = new URL(raw);
    return u.searchParams.get('p') || '';
  } catch {
    return raw;
  }
}

export async function deleteBlob(value) {
  const { deleteReceipt } = await import('../lib/google-drive.js');
  const id = pathnameFrom(value);
  if (!id || !driveConfigured()) return false;
  try {
    await deleteReceipt(id);
    return true;
  } catch (err) {
    console.error('[drive-upload] cleanup failed:', err.message);
    return false;
  }
}
