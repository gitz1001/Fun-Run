import { csvCell } from './csv.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let FIELDS = [];
let ROWS = [];
// Which group the dashboard is showing: 'all', 'public' or 'employee'.
let TYPE = 'all';
let CURRENT_PAGE = 1;
const PAGE_SIZE = 50;
// { label, value } — the answer that marks a registration as an employee's.
let EMPLOYEE = null;
// { name, label } — the waiver box on the intro page, recorded per row.
let AGREEMENT = null;
// { name, label } — the privacy consent, recorded the same way.
let PRIVACY = null;
// { field, value } while one of the figures at the top is filtering the table.
let FILTER = null;
// The last /api/staff-data payload, so the reset dialog can name the figures
// it is about to delete without going back to the server for them.
let LAST = null;

start();

async function start() {
  try {
    const res = await fetch('/api/staff-login');
    const d = await res.json();
    if (!d.ok) return gateError(d.error || 'Staff dashboard unavailable.', true);
    if (d.signedIn) return openApp();
  } catch {
    return gateError('Could not reach the server.', true);
  }
  $('gate').hidden = false;
  $('pw').focus();
  wireGate();
}

/* ---------- sign in ---------- */

function gateError(msg, fatal = false) {
  $('gate').hidden = false;
  const e = $('gate-err');
  e.textContent = msg;
  e.hidden = false;
  if (fatal) $('gate-form').querySelectorAll('input,button').forEach((el) => (el.disabled = true));
}

function wireGate() {
  $('gate-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('gate-btn');
    btn.disabled = true;
    btn.classList.add('loading');
    $('gate-err').hidden = true;

    try {
      const res = await fetch('/api/staff-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('pw').value }),
      });
      const d = await res.json();
      if (d.ok && d.signedIn) {
        $('pw').value = '';
        $('gate').hidden = true;
        return openApp();
      }
      gateError(d.error || 'That passcode is not correct.');
    } catch {
      gateError('Could not reach the server.');
    } finally {
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  });
}

/* ---------- dashboard ---------- */

function openApp() {
  $('gate').hidden = true;
  $('app').hidden = false;
  wireApp();
  load();
}

function wireApp() {
  let t;
  $('q').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { CURRENT_PAGE = 1; load($('q').value.trim()); }, 220);
  });
  $('clear').addEventListener('click', () => { $('q').value = ''; FILTER = null; CURRENT_PAGE = 1; load(); $('q').focus(); });
  $('refresh').addEventListener('click', () => load($('q').value.trim()));
  $('export').addEventListener('click', exportCsv);

  document.querySelectorAll('.seg').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.type === TYPE) return;
      TYPE = btn.dataset.type;
      CURRENT_PAGE = 1;
      document.querySelectorAll('.seg').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('on', on);
        b.setAttribute('aria-selected', String(on));
      });
      load($('q').value.trim());
    });
  });
  $('detail-close').addEventListener('click', () => $('detail').close());
  $('detail').addEventListener('click', (e) => {
    if (e.target !== $('detail')) return;
    const r = $('detail').getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) $('detail').close();
  });
  wireReset();
  $('signout').addEventListener('click', async () => {
    await fetch('/api/staff-login', { method: 'DELETE' });
    location.reload();
  });
}

async function load(q = '') {
    const offset = (CURRENT_PAGE - 1) * PAGE_SIZE;
  notice();
  $('count').textContent = 'Loading…';
  let d;
  try {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (TYPE !== 'all') params.set('type', TYPE);
    if (FILTER) { params.set('field', FILTER.field); params.set('value', FILTER.value); }
      params.set('limit', PAGE_SIZE);
      if (offset > 0) params.set('offset', offset);
    const res = await fetch('/api/staff-data' + (params.size ? `?${params}` : ''));
    if (res.status === 401) return location.reload();   // session expired
    d = await res.json();
  } catch {
    return notice('Could not reach the server.');
  }
  if (!d.ok) return notice(d.error || 'Could not load registrations.');

  FIELDS = d.fields || [];
  ROWS = d.rows || [];
  EMPLOYEE = d.employee || null;
  AGREEMENT = d.agreement || null;
  PRIVACY = d.privacy || null;
  LAST = d;
  renderSegments(d);
  renderStats(d);
  renderRows(d);
}

/** Keeps each tab's count in step, whichever group is being shown. */
const EXPORT_LABELS = {
  all: 'Export all (CSV)',
  public: 'Export non-employees (CSV)',
  employee: 'Export employees (CSV)',
};

function renderSegments(d) {
  $('export-label').textContent = EXPORT_LABELS[TYPE];
  const seg = d.segments;
  $('seg-all').textContent = d.total ?? '—';
  $('seg-public').textContent = seg ? seg.public : '—';
  $('seg-employee').textContent = seg ? seg.employee : '—';
}

function renderStats(d) {
  // [caption, figure, the question it filters on]. A figure with no question
  // behind it is a total, not a filter.
  const cards = [['Total registered', d.total, null]];
  if (d.segments) {
    cards.push(['Non-employees', d.segments.public, null]);
    cards.push(['Employees · salary deduction', d.segments.employee, null]);
  }
  for (const [key, blank] of [['category', 'Unspecified'], ['school', 'Unspecified Affiliation']]) {
    const group = d.breakdown?.[key];
    for (const c of group?.counts || []) cards.push([c.value || blank, c.n, c.value ? group.label : null]);
  }

  let html = cards.map(([k, v, field]) => {
    const figure = `<span class="stat-n">${esc(v)}</span><span class="stat-k">${esc(k)}</span>`;
    if (!field) return `<div class="stat">${figure}</div>`;
    const on = FILTER?.field === field && FILTER.value === k;
    return `<div class="stat kpi-card${on ? ' on' : ''}" role="button" tabindex="0" aria-pressed="${on}"
                 data-field="${esc(field)}" data-val="${esc(k)}"
                 title="${on ? 'Show everyone again' : `Show only ${esc(field)}: ${esc(k)}`}">${figure}</div>`;
  }).join('');

  if (d.needsAttention > 0) {
    html += `<div class="stat warn"><span class="stat-n">${esc(d.needsAttention)}</span>
             <span class="stat-k">need attention</span></div>`;
  }
  $('stats').innerHTML = html;

  // A figure filters the table to exactly that answer; pressing it again
  // lifts the filter. It works alongside the search box rather than through
  // it, so "Alumni" as a school does not also match the Alumni Department.
  $('stats').querySelectorAll('.kpi-card').forEach((card) => {
    const pick = () => {
      const { field, val } = card.dataset;
      const same = FILTER?.field === field && FILTER.value === val;
      FILTER = same ? null : { field, value: val };
      CURRENT_PAGE = 1;
      load($('q').value.trim());
    };
    card.addEventListener('click', pick);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
    });
  });

  renderPagination(d);
}

/** True when this registration is an SISC employee paying by salary deduction. */
function isEmployee(r) {
  return Boolean(EMPLOYEE) && (r.answers || {})[EMPLOYEE.label] === EMPLOYEE.value;
}

const TYPE_NAMES = { all: 'registrations', public: 'non-employees', employee: 'employees' };

function renderRows(d) {
  const tbody = $('rows');
  const groupTotal = TYPE === 'all' ? d.total : d.segments?.[TYPE] ?? d.returned;
  $('count').textContent = d.matchedReference
    ? `Exact match for ${d.matchedReference}`
    : `${d.returned} of ${groupTotal} ${TYPE_NAMES[TYPE]} shown` +
      (FILTER ? ` · ${FILTER.field}: ${FILTER.value}` : '');

  if (!ROWS.length) {
    tbody.innerHTML = '';
    $('empty').textContent = ($('q').value.trim() || FILTER)
      ? `No ${TYPE_NAMES[TYPE]} match that search.`
      : `No ${TYPE_NAMES[TYPE]} yet.`;
    $('empty').hidden = false;
    return;
  }
  $('empty').hidden = true;

  const cat = d.breakdown?.category?.label;
  const shirt = d.breakdown?.shirt?.label;

  tbody.innerHTML = ROWS.map((r, i) => {
    const a = r.answers || {};
    const problem = !r.sheet_synced || !r.email_sent;
    const status = problem
      ? `<span class="pill bad">${!r.email_sent ? 'no email' : ''}${!r.email_sent && !r.sheet_synced ? ' · ' : ''}${!r.sheet_synced ? 'not in sheet' : ''}</span>`
      : '<span class="pill ok">complete</span>';
    const kind = isEmployee(r)
      ? '<span class="pill emp">employee</span>'
      : '<span class="pill pub">non-employee</span>';
    return `<tr data-i="${i}" tabindex="0">
      <td class="mono">${esc(r.reference)}</td>
      <td>${esc(r.full_name || '—')}</td>
      <td>${kind}</td>
      <td>${esc(a['School / Affiliation'] ?? '—')}</td>
      <td>${esc(cat ? a[cat] ?? '—' : '—')}</td>
      <td>${esc(shirt ? a[shirt] ?? '—' : '—')}</td>
      <td class="dim">${esc(when(r.created_at))}</td>
      <td>${status}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('tr').forEach((tr) => {
    const open = () => showDetail(ROWS[Number(tr.dataset.i)]);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });

  // A single exact match is what staff want on race day — open it immediately.
  if (d.matchedReference && ROWS.length === 1) showDetail(ROWS[0]);
}

function when(iso) {
  try {
    return new Date(iso).toLocaleString('en-PH', {
      timeZone: 'Asia/Manila', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch { return String(iso); }
}

/**
 * What the row records about the waiver.
 *
 * Read from the column rather than the answers blob: the blob is keyed by
 * question label, and a label can be renamed. Rows written before the box
 * existed have nothing to show, and say so rather than implying a refusal.
 */
function waiverProof(r) {
  return consentProof(r.waiver_agreed, r.waiver_agreed_at);
}

/** The same reading of the privacy consent, which is recorded the same way. */
function privacyProof(r) {
  return consentProof(r.privacy_agreed, r.privacy_agreed_at);
}

function consentProof(agreed, agreedAt) {
  if (agreed === undefined || agreed === null) {
    return { text: 'Not recorded', cls: 'dim', csv: '' };
  }
  if (!agreed) return { text: 'Not agreed', cls: 'bad', csv: 'Not agreed' };
  const at = agreedAt ? ` · ${when(agreedAt)}` : '';
  return { text: 'Agreed' + at, cls: 'ok', csv: 'Agreed' };
}

/**
 * Where "Open receipt" may point, or '' when the stored value is not a
 * receipt at all.
 *
 * Only the upload question is ever linked, and only to this app's own receipt
 * route or — for rows from before that route existed — a Google Drive file.
 * Any other answer is a runner's typing and is shown as text: the old rule
 * linked every answer that looked like a URL, under a label staff trust.
 */
function receiptHref(v) {
  const s = String(v ?? '');
  const own = s.match(/^(?:https?:\/\/[^/\s]+)?\/api\/receipt\?id=([A-Za-z0-9_-]{10,200})$/);
  // Relative, so it opens on whichever host staff are signed in to.
  if (own) return `/api/receipt?id=${own[1]}`;
  return /^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]{10,200}(?:[/?#]|$)/.test(s) ? s : '';
}

function showDetail(r) {
  if (!r) return;
  const a = r.answers || {};
  $('detail-ref').textContent = r.reference;

  const rows = FIELDS.map((f) => {
    const v = a[f.label];
    if (v === undefined || v === '') return '';
    const href = f.type === 'file' ? receiptHref(v) : '';
    const val = href
      ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">Open receipt</a>`
      : esc(v);
    return `<tr><th>${esc(f.label)}</th><td>${val}</td></tr>`;
  }).join('');

  const flags = [];
  if (!r.email_sent) flags.push(`Confirmation email was not sent${r.email_error ? ` — ${esc(r.email_error)}` : ''}.`);
  if (!r.sheet_synced) flags.push(`Not written to the Google Sheet${r.sheet_error ? ` — ${esc(r.sheet_error)}` : ''}.`);

  const kind = isEmployee(r)
    ? '<p class="detail-kind emp">SGEN employee · paying by salary deduction' +
      (r.proof_url ? '' : ' <span class="detail-kind-note">— no receipt collected</span>') +
      '</p>'
    : '<p class="detail-kind pub">Non-employee · paying by bank transfer</p>';

  const waiver = waiverProof(r);
  const privacy = privacyProof(r);

  $('detail-body').innerHTML = `
    ${kind}
    ${flags.length ? `<div class="notice warn">${flags.join('<br>')}</div>` : ''}
    <table class="detail-table"><tbody>
      ${rows}
      <tr>
        <th>${esc(AGREEMENT?.label || 'Waiver of Liability')}</th>
        <td><span class="pill ${waiver.cls}">${esc(waiver.text)}</span></td>
      </tr>
      <tr>
        <th>${esc(PRIVACY?.label || 'Data Privacy Consent')}</th>
        <td><span class="pill ${privacy.cls}">${esc(privacy.text)}</span></td>
      </tr>
      <tr><th>Registered</th><td>${esc(when(r.created_at))}</td></tr>
    </tbody></table>`;

  const d = $('detail');
  if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
}

/** kind: '' for a problem (the default), 'ok' for something that went right. */
function notice(msg, kind = '') {
  const n = $('notice');
  if (!msg) { n.hidden = true; return; }
  n.className = 'banner' + (kind ? ' ' + kind : '');
  n.textContent = msg;
  n.hidden = false;
}

/* ---------- CSV export ---------- */

/**
 * Hands the finance office a spreadsheet rather than a screenshot.
 *
 * On the Employees tab the columns are the ones payroll actually needs to
 * raise a deduction — employee number, department, and the typed
 * authorisation — with the runner's own details alongside for matching. On
 * the other tabs the receipt link takes their place, since that is what a
 * non-employee's payment has to be checked against.
 */
const EXPORT_COLUMNS = {
  employee: [
    'Employee full name', 'Employee number', 'Department / Office',
    'Salary deduction authorization', 'Full name', 'Email address',
    'Contact number', 'School / Affiliation', 'Race category', 'Shirt size',
  ],
  other: [
    'Full name', 'Email address', 'Contact number', 'School / Affiliation',
    'Race category', 'Shirt size', 'Team / Organization', 'Payment method', 'Proof of payment',
  ],
};

// Exposed so the escaping above can be exercised directly by a test. It is a
// pure string function — it reads nothing and returns no data.
window.__cell = csvCell;

const csvDate = (iso) => {
  try {
    // Manila local time, sortable: 2026-11-22 08:05
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(iso)).reduce((a, x) => (a[x.type] = x.value, a), {});
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  } catch { return String(iso); }
};

/** Pulls every row of a group, not just the page on screen. */
async function fetchAllForExport(type = TYPE) {
  const rows = [];
  const pageSize = 200;
  for (let offset = 0; ; offset += pageSize) {
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset), stats: '0' });
    if (type !== 'all') params.set('type', type);
    const res = await fetch(`/api/staff-data?${params}`);
    if (res.status === 401) { location.reload(); return null; }
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'Could not read registrations.');
    rows.push(...(d.rows || []));
    if ((d.rows || []).length < pageSize) return rows;
    if (rows.length > 10000) return rows;         // hard stop, just in case
  }
}

async function exportCsv() {
  const btn = $('export');
  const label = $('export-label');
  const was = label.textContent;
  btn.disabled = true;
  label.textContent = 'Preparing…';
  notice();

  try {
    const rows = await fetchAllForExport();
    if (!rows) return;
    if (!rows.length) { notice('There is nothing to export in this group yet.'); return; }

    // Only include columns the schema still has, so a renamed question drops
    // out of the file rather than exporting a column of blanks.
    const known = new Set(FIELDS.map((f) => f.label));
    const columns = (TYPE === 'employee' ? EXPORT_COLUMNS.employee : EXPORT_COLUMNS.other)
      .filter((label) => known.has(label));

    const name = TYPE === 'employee' ? 'salary-deduction'
      : TYPE === 'public' ? 'non-employees' : 'all-registrations';
    download(buildCsv(rows, columns), csvName(name));

    // The file covers the whole group, so say so when the table on screen is
    // showing a narrower set — otherwise a searched-for name looks like the
    // whole export.
    const searching = $('q').value.trim() !== '';
    notice(`Exported ${rows.length} ${rows.length === 1 ? 'registration' : 'registrations'}` +
           (searching ? ` — every ${TYPE_NAMES[TYPE].replace(/s$/, '')} entry, not just the search results.` : '.'),
           'ok');
  } catch (err) {
    notice(err.message || 'Could not build the export.');
  } finally {
    btn.disabled = false;
    label.textContent = was;
  }
}

/**
 * One CSV, ready to hand to the browser.
 *
 * BOM first: without it Excel opens UTF-8 as Latin-1 and mangles every "ñ"
 * in a Filipino name or address.
 */
function buildCsv(rows, columns) {
  // Waiver is a fixed column on every export, not one of the question columns:
  // it is the proof of acceptance, and it should not drop out of a file
  // because a tab exports a narrow set of questions.
  const header = ['Reference', 'Registered', 'Type', 'Waiver', 'Waiver accepted at', 'Privacy consent', ...columns];
  const lines = [header.map(csvCell).join(',')];

  for (const r of rows) {
    const a = r.answers || {};
    lines.push([
      csvCell(r.reference),
      csvCell(csvDate(r.created_at)),
      csvCell(isEmployee(r) ? 'Employee' : 'Non-employee'),
      csvCell(waiverProof(r).csv),
      csvCell(r.waiver_agreed_at ? csvDate(r.waiver_agreed_at) : ''),
      csvCell(privacyProof(r).csv),
      ...columns.map((label) => csvCell(a[label] ?? '')),
    ].join(','));
  }
  return new Blob(['\uFEFF' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
}

const csvName = (what) => `sgen-run-2026-${what}-${csvDate(Date.now()).slice(0, 10)}.csv`;

/**
 * Every column a backup should carry.
 *
 * The tab exports narrow to a hand-picked set of columns, which is right for
 * payroll and the finance office. A backup is the opposite job — it is the
 * only copy left once the table has been cleared — so it keeps every question
 * in the schema, plus any answer key the rows still hold from an older
 * version of the form.
 */
function backupColumns(rows) {
  const columns = FIELDS.map((f) => f.label);
  // buildCsv already writes the waiver as a fixed column, so the copy of it
  // in the answers blob would only repeat itself here.
  const seen = new Set([...columns, AGREEMENT?.label || 'Waiver of Liability', PRIVACY?.label || 'Data Privacy Consent']);
  for (const r of rows) {
    for (const key of Object.keys(r.answers || {})) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return columns;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick so the download has taken the reference.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- reset ---------- */

/**
 * Clearing the table is the one action here that cannot be taken back, so it
 * is deliberately slow to reach: a CSV of everything downloads first, and the
 * delete stays locked until that backup has saved and the phrase below has
 * been typed exactly. The server checks the phrase again on its side.
 */
const RESET_PHRASE = 'I Accept';

// Set once the backup CSV has been handed to the browser. The confirm button
// checks it as well as the phrase, so a reset can never run unbacked.
let BACKED_UP = false;

function wireReset() {
  $('reset').addEventListener('click', openReset);
  $('reset-close').addEventListener('click', closeReset);
  $('reset-cancel').addEventListener('click', closeReset);
  $('reset-retry').addEventListener('click', backupBeforeReset);
  $('reset-go').addEventListener('click', doReset);

  $('reset-phrase').addEventListener('input', gateResetButton);
  $('reset-phrase').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || $('reset-go').disabled) return;
    e.preventDefault();
    doReset();
  });

  // Clicking the backdrop cancels, the same as the detail dialog.
  $('reset-modal').addEventListener('click', (e) => {
    if (e.target !== $('reset-modal')) return;
    const r = $('reset-modal').getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) closeReset();
  });
}

function closeReset() {
  const m = $('reset-modal');
  if (m.open) m.close(); else m.removeAttribute('open');
}

function openReset() {
  BACKED_UP = false;
  $('reset-phrase').value = '';
  $('reset-phrase').disabled = true;
  $('reset-go').disabled = true;
  $('reset-go').classList.remove('loading');
  $('reset-err').hidden = true;
  $('reset-retry').hidden = true;
  $('reset-scope').innerHTML = resetScopeHtml();

  const m = $('reset-modal');
  if (typeof m.showModal === 'function') m.showModal(); else m.setAttribute('open', '');

  backupBeforeReset();
}

/** Spells out what is about to go, using the figures already on screen. */
function resetScopeHtml() {
  const total = LAST?.total;
  if (!total) return 'There are no registrations to delete.';
  const parts = [];
  if (LAST.segments) {
    parts.push(`${LAST.segments.public} non-employee${LAST.segments.public === 1 ? '' : 's'}`);
    parts.push(`${LAST.segments.employee} employee${LAST.segments.employee === 1 ? '' : 's'}`);
  }
  return `Deletes <strong>all ${esc(total)} registration${total === 1 ? '' : 's'}</strong>` +
    (parts.length ? ` — ${esc(parts.join(' and '))}` : '') +
    '. Whichever tab is open, everything goes.';
}

async function backupBeforeReset() {
  const s = $('reset-backup');
  $('reset-retry').hidden = true;
  $('reset-err').hidden = true;
  s.className = 'reset-step-s';
  s.textContent = 'Preparing a CSV of every registration…';

  try {
    const rows = await fetchAllForExport('all');
    if (!rows) return;                      // session expired, page is reloading

    if (!rows.length) {
      s.className = 'reset-step-s';
      s.textContent = 'Nothing to back up — the table is already empty.';
      return unlockPhrase();
    }

    const name = csvName('backup');
    download(buildCsv(rows, backupColumns(rows)), name);
    s.className = 'reset-step-s good';
    s.textContent =
      `Backed up ${rows.length} registration${rows.length === 1 ? '' : 's'} to ${name}.`;
    unlockPhrase();
  } catch (err) {
    s.className = 'reset-step-s bad';
    s.textContent = `${err.message || 'Could not build the backup.'} Nothing has been deleted.`;
    $('reset-retry').hidden = false;
  }
}

function unlockPhrase() {
  BACKED_UP = true;
  $('reset-phrase').disabled = false;
  $('reset-phrase').focus();
  gateResetButton();
}

function gateResetButton() {
  $('reset-go').disabled = !BACKED_UP || $('reset-phrase').value.trim() !== RESET_PHRASE;
}

async function doReset() {
  const btn = $('reset-go');
  btn.disabled = true;
  btn.classList.add('loading');
  $('reset-err').hidden = true;

  try {
    const res = await fetch('/api/staff-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: $('reset-phrase').value.trim() }),
    });
    if (res.status === 401) return location.reload();   // session expired
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'Could not clear the registrations.');

    closeReset();
    $('q').value = '';
    await load();
    notice(`Reset complete — ${d.deleted} registration${d.deleted === 1 ? '' : 's'} deleted. ` +
           'The backup CSV is in your downloads folder.', 'ok');
  } catch (err) {
    const e = $('reset-err');
    e.textContent = err.message || 'Could not clear the registrations.';
    e.hidden = false;
  } finally {
    btn.classList.remove('loading');
    gateResetButton();
  }
}


function renderPagination(d) {
  let p = $('pagination');
  if (!p) {
    p = document.createElement('div');
    p.id = 'pagination';
    p.className = 'pagination';
    document.querySelector('.table-card').after(p);
  }
  
  const groupTotal = TYPE === 'all' ? d.total : d.segments?.[TYPE] ?? d.returned;
  const hasMore = d.returned === PAGE_SIZE; // Rough heuristic, actual count might be needed if exact
  
  // We can just rely on returned < PAGE_SIZE to disable NEXT.
  
  p.innerHTML = `
    <button type="button" id="page-prev" ${CURRENT_PAGE === 1 ? 'disabled' : ''}>&laquo; Previous</button>
    <span>Page ${CURRENT_PAGE}</span>
    <button type="button" id="page-next" ${!hasMore ? 'disabled' : ''}>Next &raquo;</button>
  `;

  $('page-prev')?.addEventListener('click', () => {
    if (CURRENT_PAGE > 1) {
      CURRENT_PAGE--;
      load($('q').value.trim());
    }
  });

  $('page-next')?.addEventListener('click', () => {
    if (hasMore) {
      CURRENT_PAGE++;
      load($('q').value.trim());
    }
  });
}
