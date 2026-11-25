/**
 * Whether new registrations are accepted.
 *
 * Closed unless REGISTRATION_OPEN=true is set, so a missing setting can never
 * reopen a closed event by accident. Registration closed on November 25, 2026.
 *
 * To reopen: set REGISTRATION_OPEN=true in Vercel AND remove class="reg-closed"
 * from <html> in public/index.html and public/chat.html, then redeploy.
 *
 * Only new registrations and receipt uploads are refused. The staff
 * dashboard, receipts and every existing record are untouched.
 */
export const registrationOpen = () => process.env.REGISTRATION_OPEN === 'true';

export const CLOSED_MESSAGE =
  'Registration for Southville Run For A Cause 2026 is closed. No late or walk-in registrations are accepted. ' +
  'Please follow the official Southville Facebook page for announcements.';

/** Answers a request for a closed registration; returns true when it did. */
export function refuseIfClosed(req, res) {
  if (registrationOpen()) return false;
  if (req.method !== 'POST') return false;
  res.setHeader('Cache-Control', 'no-store');
  res.status(403).json({ ok: false, closed: true, error: CLOSED_MESSAGE });
  return true;
}
