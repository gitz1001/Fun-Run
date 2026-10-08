import {
  passwordMatches, issueToken, sessionCookie, clearCookie,
  staffAuthConfigured, loginThrottled, noteFailedLogin, clearLoginAttempts,
  tokenValid, readCookie, NOT_ENABLED,
} from '../lib/staff-auth.js';
import { clientIp } from '../lib/rate-limit.js';

export default async function handler(req, res) {
  // Sign-in state, and a Set-Cookie on the way out: nothing here may be held
  // by a CDN or a shared cache. The other staff routes say so themselves.
  res.setHeader('Cache-Control', 'no-store, private');

  const ip = clientIp(req);

  // GET = "am I already signed in?", so the page can skip the login form.
  if (req.method === 'GET') {
    if (!staffAuthConfigured()) {
      return res.status(503).json({ ok: false, error: 'Staff dashboard is not enabled.' });
    }
    return res.status(200).json({ ok: true, signedIn: tokenValid(readCookie(req)) });
  }

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearCookie());
    return res.status(200).json({ ok: true, signedIn: false });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!staffAuthConfigured()) {
    return res.status(503).json({ ok: false, error: NOT_ENABLED() });
  }

  if (await loginThrottled(ip)) {
    return res.status(429).json({
      ok: false,
      error: 'Too many attempts. Please wait 15 minutes and try again.',
    });
  }

  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body || {};

  if (!passwordMatches(body.password)) {
    await noteFailedLogin(ip);
    console.warn(`[staff] failed sign-in from ${ip}`);
    // Deliberately vague, and identical timing regardless of why it failed.
    return res.status(401).json({ ok: false, error: 'That passcode is not correct.' });
  }

  await clearLoginAttempts(ip);
  res.setHeader('Set-Cookie', sessionCookie(issueToken()));
  console.log(`[staff] signed in from ${ip}`);
  return res.status(200).json({ ok: true, signedIn: true });
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
