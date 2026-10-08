import nodemailer from 'nodemailer';
import { emailAttachments } from './email-assets.js';

/**
 * Gmail SMTP over XOAUTH2, using a Google Cloud OAuth client.
 *
 * Required env vars (set in Vercel -> Project -> Settings -> Environment Variables):
 *   GMAIL_USER            the mailbox that sends, e.g. registrar@southville.edu.ph
 *   GOOGLE_CLIENT_ID      from Google Cloud Console -> Credentials
 *   GOOGLE_CLIENT_SECRET  the GOCSPX-... paired with that exact client id
 *   GOOGLE_REFRESH_TOKEN  from  node tools/get-refresh-token.js
 *
 * Optional:
 *   MAIL_FROM_NAME        display name (default "Registration Desk")
 *   ADMIN_COPY            bcc every confirmation here
 *
 * Fallback for non-OAuth setups:
 *   SMTP_PASSWORD         if set, an App Password is used instead of OAuth2.
 */

const required = ['GMAIL_USER'];

export function missingEnv() {
  const miss = required.filter((k) => !process.env[k]);
  if (!process.env.SMTP_PASSWORD) {
    for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']) {
      if (!process.env[k]) miss.push(k);
    }
  }
  return miss;
}

export function createTransport() {
  const miss = missingEnv();
  if (miss.length) {
    throw new Error(`Missing environment variables: ${miss.join(', ')}`);
  }

  // App Password path — simpler, no Cloud project.
  if (process.env.SMTP_PASSWORD) {
    return nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // STARTTLS
      auth: { user: process.env.GMAIL_USER, pass: process.env.SMTP_PASSWORD },
    });
  }

  // OAuth2 / XOAUTH2 path. Nodemailer refreshes the access token itself
  // using the refresh token, so no token file has to be stored or rotated.
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      type: 'OAuth2',
      user: process.env.GMAIL_USER,
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    },
  });
}

export async function sendConfirmation({ to, name, subject, html, text }) {
  const transport = createTransport();
  // Structured, not strings: the runner's name is their own typing, and an
  // address assembled by hand is one stray quote or backslash away from
  // being parsed as something else.
  const from = { name: process.env.MAIL_FROM_NAME || 'Registration Desk', address: process.env.GMAIL_USER };

  const message = {
    from,
    to: name ? { name: String(name), address: to } : to,
    subject,
    text,
    html,
    // The letterhead crest, inline. Every message this app sends uses the one
    // template, so it is attached here rather than passed in at each call.
    attachments: emailAttachments(),
  };
  if (process.env.ADMIN_COPY) message.bcc = process.env.ADMIN_COPY;

  const info = await transport.sendMail(message);
  return info.messageId;
}

/**
 * Turns Google's terse SMTP errors into something actionable.
 * These are the exact failures that stalled the e-gatepass mailer.
 */
export function explainMailError(err) {
  const m = String(err?.message || err);
  if (/invalid_client/i.test(m)) {
    return 'invalid_client — GOOGLE_CLIENT_SECRET does not match GOOGLE_CLIENT_ID. Re-copy both from the SAME OAuth client in Google Cloud Console.';
  }
  if (/invalid_grant/i.test(m)) {
    return 'invalid_grant — the refresh token is expired or revoked. If the OAuth consent screen is still in "Testing", Google kills refresh tokens after 7 days; set it to "Internal" and re-run tools/get-refresh-token.js.';
  }
  if (/535[- ]5\.7\.8/.test(m)) {
    return '535-5.7.8 — Gmail refused the credentials. For OAuth, the Workspace admin must allow SMTP/IMAP access for this user; for an App Password, 2-Step Verification must be on.';
  }
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND/i.test(m)) {
    return 'Could not reach smtp.gmail.com:587 — outbound SMTP is blocked from this network.';
  }
  return m;
}
