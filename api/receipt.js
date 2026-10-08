import { requireStaff, staffAuthConfigured, tokenValid, readCookie } from '../lib/staff-auth.js';
import { getDriveFile, getDriveFileMetadata, driveConfigured } from '../lib/google-drive.js';
import { dbConfigured, uploadKnown } from '../lib/db.js';

// What a receipt can be, and whether a browser can show it in a tab. Chrome
// has no HEIC decoder, so that one is handed over as a download.
const TYPES = {
  'image/webp': 'inline',
  'image/jpeg': 'inline',
  'image/png': 'inline',
  'application/pdf': 'inline',
  'image/heic': 'attachment',
  'image/heif': 'attachment',
};

/**
 * Serves one proof of payment to signed-in staff.
 *
 *   GET /api/receipt?id=<Drive file id>
 *
 * The Drive folder stays private; this is the only way a receipt is read.
 * It serves files this app uploaded and nothing else — the id has to be in
 * the uploads table — so it cannot be used to read the rest of the Drive.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'GET only' });
  }
  res.setHeader('Cache-Control', 'no-store, private');

  // The link sits in the Sheet as well as the dashboard. Someone who follows
  // it without a session is sent to sign in rather than shown a line of JSON.
  const wantsPage = String(req.headers?.accept || '').includes('text/html');
  if (wantsPage && staffAuthConfigured() && !tokenValid(readCookie(req))) {
    res.setHeader('Location', '/staff');
    return res.status(302).end();
  }
  if (!requireStaff(req, res)) return;
  if (!driveConfigured() || !dbConfigured()) {
    return res.status(503).json({ ok: false, error: 'File storage is not configured.' });
  }

  const id = String(req.query?.id ?? '').trim();
  if (!id || !/^[A-Za-z0-9_-]{10,200}$/.test(id)) {
    return res.status(400).json({ ok: false, error: 'Unknown receipt.' });
  }

  try {
    if (!(await uploadKnown(id))) {
      return res.status(404).json({ ok: false, error: 'Unknown receipt.' });
    }
    const meta = await getDriveFileMetadata(id);
    if (!meta) return res.status(404).json({ ok: false, error: 'That receipt no longer exists.' });
    const found = await getDriveFile(id);
    if (!found) return res.status(404).json({ ok: false, error: 'That receipt no longer exists.' });

    const disposition = TYPES[meta.mimeType];
    const name = String(meta.name || 'receipt').replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', disposition ? meta.mimeType : 'application/octet-stream');
    res.setHeader('Content-Disposition', `${disposition || 'attachment'}; filename="${name}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const buf = Buffer.from(await found.arrayBuffer());
    res.setHeader('Content-Length', buf.length);
    return res.status(200).end(buf);
  } catch (err) {
    console.error('[receipt] Drive fetch failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Could not load that receipt.' });
  }
}
