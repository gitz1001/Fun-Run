import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * What a receipt may be, and how big — shared by both ways a receipt arrives:
 *
 *   small (≤ PROXY_MAX_BYTES)  browser -> /api/drive-upload -> Drive
 *   large (≤ MAX_BYTES)        browser -> Drive directly, through a one-file
 *                              upload session /api/upload-session opened
 *
 * The split exists because Vercel refuses any function request body over
 * 4.5 MB before the code ever runs, so a bigger file cannot pass through a
 * function at all. Photos are shrunk in the browser to well under 4 MB, so in
 * practice only a large PDF — a scanned bank slip, a statement — or a photo
 * the browser could not re-encode takes the direct route.
 *
 * Keep MAX_BYTES and PROXY_MAX_BYTES in step with public/receipt-upload.js;
 * test/uploads.test.js fails if they drift apart.
 */
export const MAX_BYTES = 10 * 1024 * 1024;
export const PROXY_MAX_BYTES = 4 * 1024 * 1024;
export const MAX_MB = MAX_BYTES / (1024 * 1024);

// Photos are shrunk in the browser first: to WebP where it can encode one,
// and to JPEG where it cannot — which is every browser on an iPhone. PNG and
// HEIC are what arrives when the browser could not re-encode the picture.
export const ALLOWED = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
  'image/heic': 'heic',
  'image/heif': 'heic',
};

// The brands an ISO media file declares when it is a HEIC/HEIF still image.
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1', 'heif']);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** How many leading bytes sniff() needs to recognise every allowed type. */
export const SNIFF_BYTES = 16;

/** What a file really is, judged by its first bytes, or null. */
export function sniff(buf) {
  if (buf.length > 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
      buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.length > 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp' &&
      HEIC_BRANDS.has(buf.subarray(8, 12).toString('latin1'))) return 'heic';
  return null;
}

// The page percent-encodes the name, since a header can only carry Latin-1.
// A page from before that sends it raw, and a raw name may not decode.
const decoded = (s) => { try { return decodeURIComponent(String(s || '')); } catch { return String(s || ''); } };

export const safeName = (s) => (decoded(s) || 'receipt')
  .replace(/[^a-zA-Z0-9._-]/g, '_')
  .replace(/_{2,}/g, '_')
  .slice(-80) || 'receipt';

/** The name a receipt is stored under in Drive: the date, then the runner's file name. */
export const storedName = (raw, nonce = '') =>
  `${new Date().toISOString().slice(0, 10)}-${nonce ? `${nonce}-` : ''}${safeName(raw)}`;

export const newNonce = () => randomBytes(9).toString('base64url');

// Generous on purpose: a whole school registers from behind one campus address.
export const UPLOAD_LIMIT = { windowSec: 60 * 60, max: 60 };

/* ---------- the ticket a direct upload carries between its two steps ---------- */

// Long enough for a 10 MB file on a slow phone connection, short enough that a
// ticket fished out of a log is useless by the time anyone reads it.
const TICKET_TTL_MS = 2 * 60 * 60 * 1000;

function ticketKey() {
  const seed = process.env.UPLOAD_SECRET || process.env.STAFF_SECRET ||
    process.env.GOOGLE_CLIENT_SECRET || '';
  if (!seed) throw new Error('No secret is configured to sign upload tickets.');
  return createHash('sha256').update(`upload-ticket|${seed}`).digest();
}

const mac = (body) => createHmac('sha256', ticketKey()).update(body).digest('base64url');

/**
 * Signs what the server decided when it opened an upload session: the exact
 * name the file was given in Drive, its declared type and its size. The
 * browser carries it back to finish the upload, and cannot change any of it.
 *
 * The name holds a random nonce, so it is what ties a Drive file id the
 * browser reports to the session this server opened — nobody can claim a
 * file someone else uploaded, because they never learned its name.
 */
export function signTicket({ name, type, size }, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ n: name, t: type, s: size, e: now + TICKET_TTL_MS })).toString('base64url');
  return `${body}.${mac(body)}`;
}

/** The ticket's contents, or null if it is forged, malformed or expired. */
export function readTicket(ticket, now = Date.now()) {
  const [body, sig, extra] = String(ticket || '').split('.');
  if (!body || !sig || extra !== undefined) return null;
  const want = Buffer.from(mac(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!data || typeof data.n !== 'string' || !ALLOWED[data.t] ||
      !Number.isInteger(data.s) || data.s < 1 || data.s > MAX_BYTES) return null;
  if (!Number.isFinite(data.e) || now > data.e) return null;
  return { name: data.n, type: data.t, size: data.s };
}
