/**
 * Local dev server that mimics Vercel's routing:
 *   /            -> public/index.html
 *   /api/<name>  -> api/<name>.js  (default export handler)
 *
 *   node tools/dev-server.js [port]
 *
 * Vercel itself does not need this — it is only so the app can be run
 * without installing the Vercel CLI.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

for (const file of ['.env.local', '.env']) {
  const p = path.join(root, file);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.woff2': 'font/woff2', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.xml': 'application/xml',
};

/**
 * The response headers vercel.json sends in production, applied here too.
 *
 * Without this, the strictest thing about the deployed site — its
 * Content-Security-Policy — is the one thing local development never
 * exercises, so a violation could only ever be found after a deploy.
 */
const WILDCARD = '\u0000';

/**
 * Vercel's `source` is path-to-regexp. This config uses two shapes: a `(.*)`
 * tail, and an alternation like `(styles.css|app.js)`. So park the wildcards,
 * escape the dots that are meant literally, and put the wildcards back —
 * leaving the alternation groups to work as the regex groups they already are.
 */
function sourceToRegExp(source) {
  const body = source
    .split('(.*)').join(WILDCARD)
    .replace(/\./g, '\\.')
    .split(WILDCARD).join('.*');
  return new RegExp(`^${body}$`);
}

const HEADER_RULES = (() => {
  try {
    const cfg = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'));
    return (cfg.headers || []).map((rule) => ({
      test: sourceToRegExp(rule.source),
      headers: rule.headers || [],
    }));
  } catch (err) {
    console.warn('dev-server: could not read the headers from vercel.json -', err.message);
    return [];
  }
})();

/** Every matching rule applies, later ones winning, exactly as on Vercel. */
function applyConfiguredHeaders(res, pathname) {
  for (const rule of HEADER_RULES) {
    if (rule.test.test(pathname)) {
      for (const h of rule.headers) res.setHeader(h.key, h.value);
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);

  // --- API routes -------------------------------------------------
  if (pathname.startsWith('/api/')) {
    const name = pathname.slice(5).replace(/[^a-zA-Z0-9_-]/g, '');
    const file = path.join(root, 'api', `${name}.js`);
    if (!existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'No such endpoint' }));
    }

    applyConfiguredHeaders(res, pathname);

    const body = await readBody(req);
    const shim = {
      method: req.method,
      headers: req.headers,
      query: Object.fromEntries(url.searchParams),
      body,
    };
    const resShim = {
      statusCode: 200,
      setHeader: (k, v) => res.setHeader(k, v),
      status(code) { this.statusCode = code; return this; },
      json(obj) {
        res.writeHead(this.statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      },
      send(text) { res.writeHead(this.statusCode); res.end(text); },
      end(buf) { res.writeHead(this.statusCode); res.end(buf); },
      get statusCodeOut() { return this.statusCode; },
    };

    try {
      // Vercel reuses a warm instance, so by default we import once and keep
      // module state (this is what makes the rate limiter behave realistically).
      // Set DEV_HOT=1 for cache-busting hot reload while editing.
      const base = new URL(`../api/${name}.js`, import.meta.url).href;
      const spec = process.env.DEV_HOT ? `${base}?t=${Date.now()}` : base;
      const mod = await import(spec);
      await mod.default(shim, resShim);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // --- static -----------------------------------------------------
  if (pathname === '/') pathname = '/index.html';
  // Match Vercel's cleanUrls: /staff serves staff.html
  if (!path.extname(pathname) && existsSync(path.join(root, 'public', pathname + '.html'))) {
    pathname += '.html';
  }
  const file = path.join(root, 'public', pathname);
  if (!file.startsWith(path.join(root, 'public')) || !existsSync(file)) {
    res.writeHead(404).end('Not found');
    return;
  }
  // Matched against the URL as Vercel sees it: cleanUrls means the rule for
  // /staff has to fire for what is on disk as staff.html, and / for index.html.
  applyConfiguredHeaders(res, pathname === '/index.html' ? '/' : pathname.replace(/\.html$/, ''));
  res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
  res.writeHead(200);
  res.end(await readFile(file));
});

/**
 * Mirrors how Vercel exposes the body: JSON and form-encoded requests arrive
 * parsed, anything else (an image or PDF upload) arrives as a raw Buffer.
 */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return resolve({});

      const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ct === 'application/json') {
        try { return resolve(JSON.parse(buf.toString('utf8'))); }
        catch { return resolve({}); }
      }
      if (ct === 'application/x-www-form-urlencoded') {
        return resolve(Object.fromEntries(new URLSearchParams(buf.toString('utf8'))));
      }
      resolve(buf);
    });
  });
}

const port = Number(process.argv[2]) || 3000;
server.listen(port, () => console.log(`Dev server: http://localhost:${port}`));
