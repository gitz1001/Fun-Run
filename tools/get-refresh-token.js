/**
 * One-time helper: exchanges a Google OAuth consent for a REFRESH TOKEN
 * that Nodemailer can use forever (as long as the consent screen is
 * "Internal" or the app is Published).
 *
 *   node tools/get-refresh-token.js
 *
 * Google Cloud Console setup first:
 *   1. APIs & Services -> Library -> enable "Gmail API", "Google Sheets API" AND "Google Drive API".
 *   2. OAuth consent screen -> User type INTERNAL when using Google Workspace (or publish the app for external use).
 *   3. Credentials -> Create OAuth client ID -> Web application.
 *      Authorised redirect URI:  http://localhost:5555/oauth2callback
 *   4. Copy the Client ID and Client secret from THAT SAME client and put
 *      them below (or in the environment) — a mismatched pair is the
 *      "invalid_client" error.
 */

import http from 'node:http';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Read .env.local first, so the client id and secret can live there rather
// than being typed in (or pasted into a terminal that keeps history).
const root = fileURLToPath(new URL('..', import.meta.url));
for (const file of ['.env.local', '.env']) {
  const p = path.join(root, file);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const PORT = 5555;
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;
// Gmail (to send) + Sheets (to append the mirror row) on one consent.
const SCOPE = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
].join(' ');

const rl = createInterface({ input: stdin, output: stdout });
const clientId = process.env.GOOGLE_CLIENT_ID || (await rl.question('Client ID: ')).trim();
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || (await rl.question('Client secret: ')).trim();
rl.close();

if (!clientId || !clientSecret) {
  console.error('Both a client id and a client secret are required.');
  process.exit(1);
}

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent', // forces a refresh_token to be returned every time
  });

console.log('\nOpen this URL in the browser, signed in as the SENDING mailbox:\n');
console.log(authUrl + '\n');
console.log(`Waiting for the redirect on ${REDIRECT} …`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404).end('Not found');
    return;
  }

  const err = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  if (err || !code) {
    res.writeHead(400, { 'Content-Type': 'text/html' })
       .end(`<h2>Authorisation failed</h2><p>${err || 'no code returned'}</p>`);
    console.error('\nAuthorisation failed:', err || 'no code returned');
    setTimeout(() => process.exit(1), 100);
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    }),
  });
  const tok = await tokenRes.json();

  if (!tokenRes.ok || !tok.refresh_token) {
    res.writeHead(500, { 'Content-Type': 'text/html' })
       .end('<h2>Token exchange failed</h2><p>See the terminal.</p>');
    console.error('\nToken exchange failed:', JSON.stringify(tok, null, 2));
    if (tok.error === 'invalid_client') {
      console.error('\ninvalid_client => the client id and secret are not from the same OAuth client.');
    }
    if (!tok.refresh_token && tokenRes.ok) {
      console.error('\nNo refresh_token returned. Revoke prior access at');
      console.error('https://myaccount.google.com/permissions and run this again.');
    }
    setTimeout(() => process.exit(1), 100);
  }

  res.writeHead(200, { 'Content-Type': 'text/html' })
     .end('<h2>Done</h2><p>Refresh token issued. You can close this tab and return to the terminal.</p>');

  // Write it straight into .env.local so the secret never has to be copied
  // through a terminal or a chat window.
  try {
    const envPath = path.join(root, '.env.local');
    if (existsSync(envPath)) {
      let env = readFileSync(envPath, 'utf8');
      const set = (k, v) => {
        // Every line for the name, not only the first: an older
        // GOOGLE_REFRESH_TOKEN left further down the file would otherwise
        // still be there to be read. A function, so "$" in a value stays "$".
        const re = new RegExp('^' + k + '=.*$', 'gm');
        env = re.test(env) ? env.replace(re, () => k + '=' + v) : env.trimEnd() + '\n' + k + '=' + v + '\n';
      };
      set('GOOGLE_CLIENT_ID', clientId);
      set('GOOGLE_CLIENT_SECRET', clientSecret);
      set('GOOGLE_REFRESH_TOKEN', tok.refresh_token);
      writeFileSync(envPath, env);
      console.log('\nWritten into .env.local — nothing to copy by hand.');
      console.log('If GMAIL_USER is still blank there, set it to the address you just');
      console.log('signed in as, then run:  npm run doctor');
    }
  } catch (e) {
    console.error('\nCould not write .env.local automatically:', e.message);
  }

  console.log('\n=== Same values for Vercel -> Settings -> Environment Variables ===\n');
  console.log(`GOOGLE_CLIENT_ID=${clientId}`);
  console.log(`GOOGLE_CLIENT_SECRET=${clientSecret}`);
  console.log(`GOOGLE_REFRESH_TOKEN=${tok.refresh_token}`);
  console.log('\n(Keep the refresh token secret — it grants access to send as that mailbox.)');
  console.log('\nReminder: if the OAuth consent screen is still in "Testing", this token');
  console.log('dies in 7 days. Set it to "Internal" to make it permanent.\n');

  setTimeout(() => process.exit(0), 100);
});

server.listen(PORT);
