import { getAccessToken, oauthConfigured, explainTokenError } from './google-auth.js';
import { FORM, AGREEMENT, PRIVACY } from './form-schema.js';

/**
 * Appends registrations straight into a Google Sheet.
 *
 * This replaces posting to a Google Form's /formResponse endpoint. Writing to
 * the Sheet directly means:
 *   - no form has to be public (that was the HTTP 401 that blocked everything)
 *   - no entry.NNNN ids to scrape
 *   - we choose the columns, so a file-upload question is not a problem
 *   - it uses the documented Sheets API rather than an undocumented endpoint
 *
 * Config:
 *   SHEET_ID   the long id from the sheet URL:
 *              docs.google.com/spreadsheets/d/<SHEET_ID>/edit
 *   SHEET_TAB  optional tab name, defaults to "Registrations"
 */

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

export const sheetId = () => process.env.SHEET_ID || '';
export const sheetTab = () => process.env.SHEET_TAB || 'Registrations';
export const sheetsConfigured = () => Boolean(sheetId()) && oauthConfigured();

/** Columns written, in order: our own metadata then one per question. */
export function headerRow() {
  return ['Timestamp', 'Reference', ...FORM.fields.map((f) => f.label), AGREEMENT.label, PRIVACY.label];
}

async function call(path, { method = 'GET', body, params } = {}) {
  const token = await getAccessToken();
  const qs = params ? '?' + new URLSearchParams(params) : '';
  const res = await fetch(`${API}/${sheetId()}${path}${qs}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw new Error(explainSheetError(res.status, msg));
  }
  return data;
}

export function explainSheetError(status, msg) {
  if (status === 404) {
    return `Spreadsheet not found — check SHEET_ID. (${msg})`;
  }
  if (status === 403) {
    return `Access denied to the spreadsheet. The Google account that issued the refresh ` +
           `token must be able to edit it, and the token needs the spreadsheets scope — ` +
           `re-run "npm run token". (${msg})`;
  }
  if (status === 401) {
    return `Google rejected the access token. Re-run "npm run token". (${msg})`;
  }
  return msg;
}

/** Creates the tab if it is missing, and writes the header row if row 1 is empty. */
export async function ensureSheet() {
  const meta = await call('', { params: { fields: 'sheets.properties.title' } });
  const titles = (meta.sheets || []).map((s) => s.properties.title);

  if (!titles.includes(sheetTab())) {
    await call(':batchUpdate', {
      method: 'POST',
      body: { requests: [{ addSheet: { properties: { title: sheetTab() } } }] },
    });
  }

  const head = await call(`/values/${encodeURIComponent(`${sheetTab()}!1:1`)}`);
  const existing = head.values?.[0] || [];
  const wanted = headerRow();

  if (existing.length === 0) {
    await call(`/values/${encodeURIComponent(`${sheetTab()}!A1`)}`, {
      method: 'PUT',
      params: { valueInputOption: 'RAW' },
      body: { values: [wanted] },
    });
    return { created: !titles.includes(sheetTab()), headers: 'written' };
  }

  // Production-safe migration: never insert/reorder columns in an existing
  // sheet because doing so could shift historical data. If the deployed form
  // gains a new question, append only the missing headers to the right.
  //
  // This is important for live registrations: older rows keep their original
  // column positions, while new rows are written against the actual header
  // order currently in the sheet.
  const missing = wanted.filter((h) => !existing.includes(h));
  if (missing.length) {
    const startCol = columnLetter(existing.length + 1);
    const endCol = columnLetter(existing.length + missing.length);
    await call(`/values/${encodeURIComponent(`${sheetTab()}!${startCol}1:${endCol}1`)}`, {
      method: 'PUT',
      params: { valueInputOption: 'RAW' },
      body: { values: [missing] },
    });
    return {
      created: false,
      headers: 'migrated',
      existing: [...existing, ...missing],
      added: missing,
    };
  }

  return { created: false, headers: 'match', existing };
}

function columnLetter(number) {
  let n = Number(number);
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * Appends one registration. Returns {ok, error} rather than throwing, because
 * the caller treats the Sheet as a mirror and must not fail the request on it.
 */
/** Manila local time, sortable as plain text: 2026-11-22 08:05:31 */
export function sheetTimestamp(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export async function appendRegistration({ reference, labelled }) {
  if (!sheetsConfigured()) {
    return { ok: false, error: 'Sheet mirror not configured (SHEET_ID / Google OAuth).' };
  }
  try {
    // Keep the live Sheet compatible with older production rows. A newly
    // deployed question is appended as a new column rather than inserted in
    // the middle, so historical data can never be shifted accidentally.
    const setup = await ensureSheet();
    let existing = setup.existing || headerRow();

    // A sheet that had an empty first row was just initialised above.
    // For an existing sheet, build the row from its actual header order.
    // This lets a newly added field such as School / Affiliation live safely
    // in the newly appended column while all legacy columns stay aligned.
    const metadata = new Map([
      ['Timestamp', sheetTimestamp()],
      ['Reference', reference],
      [AGREEMENT.label, String(labelled[AGREEMENT.label] ?? '')],
      [PRIVACY.label, String(labelled[PRIVACY.label] ?? '')],
    ]);
    const row = existing.map((header) =>
      metadata.has(header) ? metadata.get(header) : String(labelled[header] ?? '')
    );

    await call(`/values/${encodeURIComponent(`${sheetTab()}!A1`)}:append`, {
      method: 'POST',
      // RAW, not USER_ENTERED: Sheets would otherwise parse "09171234567" as a
      // number and strip the leading zero from every Philippine mobile number.
      params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' },
      body: { values: [row] },
    });
    return { ok: true, error: '' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
