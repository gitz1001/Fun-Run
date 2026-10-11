/**
 * The registration assistant: the same registration as the form, asked one
 * question at a time.
 *
 * It is scripted, not a language model. The questions, their order, their
 * options and their rules all come from /api/schema — the same source the
 * form is drawn from — and the answers go to the same two endpoints:
 *
 *   POST /api/drive-upload   the receipt, which returns a file id
 *   POST /api/register       every answer, the two consents and that id
 *
 * so a registration made here is recorded, mirrored to the Sheet and emailed
 * exactly as one made on the form is. Nothing on the form's page is used or
 * changed: the handful of rules both need are repeated here on purpose.
 *
 * The file builds its own button and panel, so a page only has to load it
 * (and chat.css). <body data-chat-open> opens the panel straight away.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STORE = 'sfo_chat_v1';
const WAIVER_PDF = '/docs/official-waiver.pdf';
const PRIVACY_PAGE = '/data.html';
const CONTACTS = ['edgar_baobaoen@southville.edu.ph', 'sary_escurel@southville.edu.ph'];
const BANK = {
  bank: 'Philippine National Bank (PNB) Account, Las Piñas-Aguilar Avenue',
  name: 'Southville Social Environmental Educational Development Foundation Inc.',
  number: '1451-7000-1355',
  image: '/payment/bank_transfer.png',
};

let SCHEMA = null;
/** What is being asked right now: { type, field?, sub? }. */
let current = null;
let busy = false;

/* ---------- state, kept for the tab's lifetime ---------- */

function newId() {
  const bytes = new Uint8Array(12);
  (window.crypto || window.msCrypto).getRandomValues(bytes);
  return 'c' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const fresh = () => ({
  waiver: false,
  privacy: false,
  answers: {},        // field name -> answer; '' for an optional one skipped
  file: null,         // { name, size } of the receipt, for the summary
  ask: null,          // a field being corrected from the summary
  submissionId: newId(),
  log: [],
});

/**
 * Progress survives a reload, which on a phone is one stray swipe away.
 * sessionStorage, not localStorage: it ends with the tab, so answers typed on
 * a shared computer are not there for the next person to find.
 */
function load() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE) || 'null');
    if (saved && typeof saved === 'object' && saved.answers && saved.submissionId) {
      return { ...fresh(), ...saved };
    }
  } catch { /* private mode, or nothing saved */ }
  return null;
}
function save() {
  try {
    sessionStorage.setItem(STORE, JSON.stringify({ ...state, log: state.log.slice(-80) }));
  } catch { /* the chat works without it */ }
}
function forget() {
  try { sessionStorage.removeItem(STORE); } catch { /* nothing to clear */ }
}

const restored = load();
let state = restored || fresh();

/* ---------- the rules shared with the form ---------- */

// Built from code points so no invisible character has to sit in this file.
const range = (a, b) => String.fromCharCode(a) + '-' + String.fromCharCode(b);
const INVISIBLE = new RegExp(
  '[' + range(0x200B, 0x200F) + range(0x202A, 0x202E) + range(0x2060, 0x2069) + String.fromCharCode(0xFEFF) + ']', 'g');
const ODD_SPACES = new RegExp('[' + String.fromCharCode(0x00A0, 0x2007, 0x202F) + ']', 'g');

/** Drops what iOS wraps an autofilled or pasted number in. */
const tidy = (v) => String(v ?? '').replace(INVISIBLE, '').replace(ODD_SPACES, ' ').trim();

function isActive(field, answers) {
  const cond = field.showIf;
  if (!cond) return true;
  const raw = answers?.[cond.field];
  const now = typeof raw === 'string' ? raw.trim() : '';
  if (cond.equals !== undefined) return now === cond.equals;
  if (cond.notEquals !== undefined) return now !== cond.notEquals;
  return now !== '';
}

/** '' when the answer is acceptable, otherwise what is wrong with it. */
function checkField(f, value) {
  if (f.type === 'file') {
    if (!value) return 'I still need your proof of payment';
    return /^[A-Za-z0-9_-]{10,200}$/.test(value) ? '' : 'That upload did not finish';
  }
  if (f.required && !value) return 'I need an answer for this one';
  if (!value) return '';
  if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return 'That does not look like an email address — it should look like name@example.com';
  }
  if (f.pattern) {
    if (!f._re) f._re = new RegExp(f.pattern);
    if (!f._re.test(value)) return (f.patternMessage || 'That is not in the format I expected').replace(/\.$/, '');
  }
  const max = f.maxLength || (f.type === 'paragraph' ? 2000 : 300);
  if (value.length > max) return `That is too long — please keep it under ${max} characters`;
  return '';
}

const isPhone = (f) => /number|phone|contact|mobile/i.test(f.label)
  && !/name/i.test(f.label) && f.type !== 'email';
const digitsOnly = (f) => /^\^\[0-9\]\{/.test(f.pattern || '');
const isTouch = () => window.matchMedia?.('(pointer: coarse)').matches === true;

/* ---------- the widget ---------- */

const ICON = {
  chat: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 8.7 8.7 0 0 1-3.7-.8L3 20.5l1.6-5A8.2 8.2 0 0 1 4 11.5a8.4 8.4 0 0 1 8.5-8.3A8.4 8.4 0 0 1 21 11.5Z"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  restart: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5v4.6h4.6"/></svg>',
  send: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M12.5 6.5 18 12l-5.5 5.5"/></svg>',
  clip: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11.5 12.2 19a5 5 0 0 1-7-7l8-7.8a3.3 3.3 0 0 1 4.7 4.7l-7.9 7.7a1.7 1.7 0 0 1-2.4-2.4l7-6.9"/></svg>',
};

const launch = document.createElement('button');
launch.type = 'button';
launch.className = 'cb-launch';
launch.setAttribute('aria-expanded', 'false');
launch.innerHTML = `${ICON.chat}<span>Register by chat</span>`;

const panel = document.createElement('section');
panel.className = 'cb-panel';
panel.hidden = true;
panel.setAttribute('role', 'dialog');
panel.setAttribute('aria-label', 'Registration assistant');
panel.innerHTML = `
  <header class="cb-head">
    <div class="cb-head-t">
      <strong>Registration assistant</strong>
      <span>Southville Run For A Cause 2026</span>
    </div>
    <button type="button" class="cb-icon" data-act="restart" aria-label="Start over" title="Start over">${ICON.restart}</button>
    <button type="button" class="cb-icon" data-act="close" aria-label="Close chat" title="Close">${ICON.close}</button>
  </header>
  <div class="cb-track" role="progressbar" aria-label="Registration progress"
       aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="cb-fill"></div></div>
  <div class="cb-log" role="log" aria-live="polite" aria-relevant="additions"></div>
  <div class="cb-quick"></div>
  <form class="cb-compose" novalidate autocomplete="off">
    <input class="cb-hp" type="text" name="_hp" tabindex="-1" autocomplete="off" aria-hidden="true">
    <input class="cb-input" type="text" aria-label="Your answer" enterkeyhint="send">
    <textarea class="cb-input" rows="2" aria-label="Your answer" enterkeyhint="send" hidden></textarea>
    <button type="submit" class="cb-send" aria-label="Send">${ICON.send}</button>
  </form>`;

document.body.append(launch, panel);

const log = panel.querySelector('.cb-log');
const quick = panel.querySelector('.cb-quick');
const compose = panel.querySelector('.cb-compose');
const line = panel.querySelector('input.cb-input');
const area = panel.querySelector('textarea.cb-input');
const honeypot = panel.querySelector('.cb-hp');
const track = panel.querySelector('.cb-track');
const fill = panel.querySelector('.cb-fill');

/** The box in use: one line for most questions, several for a long answer. */
let box = line;

/* ---------- messages ---------- */

const toEnd = () => { log.scrollTop = log.scrollHeight; };

function bubble(who, node, extra = '') {
  const el = document.createElement('div');
  el.className = `cb-msg ${who === 'u' ? 'cb-user' : 'cb-bot'}${extra ? ' ' + extra : ''}`;
  if (typeof node === 'string') el.textContent = node; else el.append(node);
  log.append(el);
  toEnd();
  return el;
}

/** A plain message. Text only, so a runner's own words are never markup. */
function say(text, { warn = false, keep = true } = {}) {
  if (keep) { state.log.push({ w: 'b', t: text, x: warn ? 1 : 0 }); save(); }
  return bubble('b', text, warn ? 'cb-warn' : '');
}
function said(text) {
  state.log.push({ w: 'u', t: text });
  save();
  return bubble('u', text);
}

/**
 * Messages with something in them besides words. Each is built here from the
 * schema and the constants above — never from anything typed — and is logged
 * by name, so a reload redraws it instead of replaying stored HTML.
 */
const RICH = {
  waiver: () => `
    <p>Before anything else, please read the <strong>Waiver of Liability</strong>.</p>
    <a class="cb-doc" href="${WAIVER_PDF}" target="_blank" rel="noopener">
      <span>Waiver of Liability<small>PDF · opens in a new tab</small></span></a>
    <p class="cb-note">Do you accept the Waiver of Liability, and agree to its terms for the
      Southville Run For A Cause 2026?</p>`,
  privacy: () => `
    <p>Next, the <strong>Data Privacy Advisory</strong>. It explains what we collect and why.</p>
    <a class="cb-doc" href="${PRIVACY_PAGE}" target="_blank" rel="noopener">
      <span>Data Privacy Advisory<small>Opens in a new tab</small></span></a>
    <p class="cb-note">Do you consent to the collection and processing of your personal data for
      this registration?</p>`,
  contact: () => `<p>For any questions, you can email us at ${
    CONTACTS.map((c) => `<a href="mailto:${c}">${c}</a>`).join(' or ')}.</p>`,
  bank: () => `
    <p><strong>Bank transfer details</strong></p>
    <dl class="cb-dl">
      <div><dt>Bank name</dt><dd>${esc(BANK.bank)}</dd></div>
      <div><dt>Account name</dt><dd>${esc(BANK.name)}</dd></div>
      <div><dt>Account number</dt><dd class="cb-acct"><b>${esc(BANK.number)}</b>
        <button type="button" class="cb-mini" data-copy="${esc(BANK.number)}">Copy</button></dd></div>
    </dl>
    <p class="cb-note"><a href="${BANK.image}" target="_blank" rel="noopener">See the bank details as a picture</a></p>`,
  chart: (fitId) => {
    const chart = fieldByName('shirt_size')?.sizeChart;
    const fit = chart?.fits?.find((x) => x.id === fitId);
    if (!fit) return '';
    const inch = (n) => (n == null ? '—' : `${Math.round(n * 10) / 10}"`);
    const head = fit.columns.map((c) => `<th scope="col">${esc(c.label)}</th>`).join('');
    const rows = fit.sizes.map((s) => `<tr><td><b>${esc(s.value)}</b></td>${
      fit.columns.map((c) => `<td>${c.key === 'alias' ? esc(s[c.key] || '—') : inch(s[c.key])}</td>`).join('')}</tr>`).join('');
    return `<p><strong>${esc(fit.label)} sizes</strong> · ${esc(fit.tagline)}</p>
      <table class="cb-table"><thead><tr><th scope="col">Size</th>${head}</tr></thead><tbody>${rows}</tbody></table>
      <p class="cb-note">Chest is measured across the flat shirt and doubled. Measurements are approximate, in inches.</p>`;
  },
  jersey: (cat) => `<p>Here is the <strong>${esc(cat)}</strong> race shirt.</p>
    <img class="cb-jersey" src="/shirt/jersey/${esc(String(cat).toLowerCase())}-front.png" alt="${esc(cat)} race shirt, front">`,
  done: (ref) => `<p><strong>You are registered!</strong></p>
    <div class="cb-ref"><span>Your reference</span><b>${esc(ref)}</b></div>
    <p><button type="button" class="cb-mini" data-copy="${esc(ref)}">Copy reference</button></p>`,
};

function rich(kind, data, { keep = true } = {}) {
  const html = RICH[kind]?.(data);
  if (!html) return null;
  if (keep) { state.log.push({ w: 'b', k: kind, d: data ?? null }); save(); }
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  // A picture that is not there yet leaves no broken-image icon behind.
  wrap.querySelectorAll('img').forEach((img) => img.addEventListener('error', () => img.remove()));
  wrap.querySelectorAll('img').forEach((img) => img.addEventListener('load', toEnd));
  return bubble('b', wrap, 'cb-rich');
}

function redraw() {
  log.textContent = '';
  for (const m of state.log) {
    if (m.k) rich(m.k, m.d, { keep: false });
    else if (m.w === 'u') bubble('u', m.t);
    else bubble('b', m.t, m.x ? 'cb-warn' : '');
  }
}

/* ---------- the answer area ---------- */

/** Tap-to-answer buttons. Each is { label, value, style?, hint? }. */
function chips(list) {
  quick.textContent = '';
  for (const c of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cb-chip' + (c.style ? ` cb-${c.style}` : '');
    b.textContent = c.label;
    if (c.hint) {
      const small = document.createElement('small');
      small.textContent = ` · ${c.hint}`;
      b.append(small);
    }
    b.addEventListener('click', () => { if (!busy) answer(c.value, c.label, true); });
    quick.append(b);
  }
  toEnd();
}

/**
 * Sets up the text box for a question, or puts it away.
 * `mode` is 'line', 'area' or 'none'.
 */
function composer(mode, { placeholder = 'Type your answer', type = 'text', inputmode = 'text', autocomplete = 'off', max } = {}) {
  compose.hidden = mode === 'none';
  if (mode === 'none') return;
  box = mode === 'area' ? area : line;
  line.hidden = mode === 'area';
  area.hidden = mode !== 'area';
  box.value = '';
  box.placeholder = placeholder;
  box.setAttribute('inputmode', inputmode);
  box.setAttribute('autocomplete', autocomplete);
  if (max) box.setAttribute('maxlength', String(max)); else box.removeAttribute('maxlength');
  if (box === line) line.type = type;
  // A keyboard that opens by itself covers half a phone's screen before the
  // question has been read, so the box is only focused where there is none.
  if (!isTouch() && !panel.hidden) box.focus({ preventScroll: true });
}

/* ---------- which question is next ---------- */

const fieldByName = (name) => SCHEMA?.fields.find((f) => f.name === name);
const activeFields = () => SCHEMA.fields.filter((f) => isActive(f, state.answers));
const answered = (f) => Object.prototype.hasOwnProperty.call(state.answers, f.name);

/** Answers to questions that have stopped applying are let go. */
function prune() {
  for (const f of SCHEMA.fields) {
    if (isActive(f, state.answers) || !answered(f)) continue;
    delete state.answers[f.name];
    if (f.type === 'file') state.file = null;
  }
}

function progress() {
  const need = activeFields().filter((f) => f.required);
  const got = need.filter((f) => answered(f) && !checkField(f, state.answers[f.name])).length
    + (state.waiver ? 1 : 0) + (state.privacy ? 1 : 0);
  const pct = Math.round((got / (need.length + 2)) * 100);
  fill.style.width = `${pct}%`;
  track.setAttribute('aria-valuenow', String(pct));
}

function next() {
  progress();
  save();
  if (!state.waiver) return askConsent('waiver');
  if (!state.privacy) return askConsent('privacy');
  if (state.ask) {
    const f = fieldByName(state.ask);
    if (f && isActive(f, state.answers)) return askField(f);
    state.ask = null;
  }
  const todo = activeFields().find((f) => !answered(f));
  if (todo) return askField(todo);
  return review();
}

/* ---------- consents ---------- */

const CONSENT = {
  waiver: { yes: 'I accept the waiver', no: 'I do not accept', done: 'Thank you.' },
  privacy: { yes: 'I consent', no: 'I do not consent', done: 'Thank you. Now your details.' },
};

function askConsent(which) {
  current = { type: which };
  rich(which);
  consentChips(which);
}
function consentChips(which) {
  composer('line', { placeholder: 'Or type "I agree"' });
  chips([
    { label: CONSENT[which].yes, value: 'yes', style: 'primary' },
    { label: CONSENT[which].no, value: 'no', style: 'quiet' },
  ]);
}

function onConsent(which, raw) {
  const t = raw.toLowerCase();
  // "I don't agree" has "agree" in it, so the refusals are looked for first.
  const no = /\b(no|not|don'?t|do not|disagree|decline|refuse)\b/.test(t);
  const yes = !no && /\b(yes|agree|accept|consent|ok|okay|sure)\b/.test(t);
  if (yes) {
    state[which] = true;
    say(CONSENT[which].done);
    return next();
  }
  if (no) {
    say(which === 'waiver'
      ? 'That is all right — but I cannot register you without the waiver. If you change your mind, just tap the button below.'
      : 'That is all right — but I cannot register you without your consent to process these details. If you change your mind, just tap the button below.');
    rich('contact');
    return consentChips(which);
  }
  say('Sorry, I did not catch that. Please tap one of the two buttons below.', { warn: true });
  return consentChips(which);
}

/* ---------- questions ---------- */

/** How each question is put. Any question not listed is asked by its label. */
const PROMPTS = {
  full_name: 'What is your full name? Please type it as it should appear on your certificate.',
  email_address: 'What is your email address? Your confirmation will be sent there.',
  contact_number: 'What is your contact number?',
  age: 'How old are you, in years?',
  sex: 'What is your sex?',
  school_affiliation: 'Which school or Southville affiliation are you from?',
  race_category: 'Which race category are you joining?',
  shirt_size: 'What shirt size would you like? First, which fit?',
  team_or_organization: 'Are you running with a team or organization? Type its name, or skip this if you are running as an individual.',
  payment_method: 'How will you pay? SGEN employees may choose "Employee" to pay through salary deduction.',
  sd_full_name: 'For the salary deduction: what is your full name as an employee?',
  sd_employee_number: 'What is your employee number?',
  sd_department: 'Which department or office are you with?',
  sd_authorization: 'To authorize the deduction from your payroll, please type your LAST NAME, FIRST NAME — with a comma between them.',
  proof_of_payment: 'Please send your proof of payment: a photo, a screenshot or a PDF of your deposit slip or transfer receipt (up to 4 MB).',
  emergency_contact_name: 'Who should we contact in an emergency? Please give their name.',
  emergency_contact_number: 'What is their contact number?',
  medical_conditions: 'Do you have any medical conditions or allergies our medical team should know about? Tap "None" if not.',
};
const promptFor = (f) => PROMPTS[f.name] || `${f.label}?${f.help ? ' ' + f.help : ''}`;

const fitsOf = (f) => f.sizeChart?.fits || [];

function askField(f, { again = false } = {}) {
  current = { type: 'field', field: f };
  if (!again) {
    if (f.type === 'file') rich('bank');
    say(promptFor(f));
  }
  showInput(f);
}

/** Draws the buttons and the box for a question, without asking it again. */
function showInput(f) {
  const skip = f.required ? [] : [{ label: 'Skip', value: '', style: 'quiet' }];

  if (f.type === 'file') {
    composer('none');
    return attach(f);
  }
  if (f.type === 'choice' && fitsOf(f).length) {
    // Twenty-one sizes at once is a wall of buttons, so the cut comes first.
    current.sub = 'fit';
    composer('line', { placeholder: 'Or type your size, like M or Kids 12' });
    return chips(fitsOf(f).map((x) => ({ label: x.label, value: `fit:${x.id}`, hint: x.tagline })));
  }
  if (f.type === 'choice') {
    composer('line', { placeholder: 'Tap an option above' });
    return chips([...f.options.map((o) => ({ label: o, value: o })), ...skip]);
  }
  if (f.type === 'paragraph') {
    composer('area', { placeholder: 'Type your answer', max: f.maxLength });
    return chips([{ label: 'None', value: 'None' }]);
  }
  composer('line', {
    placeholder: f.placeholder ? `e.g. ${f.placeholder.replace(/^e\.g\.\s*/i, '')}` : 'Type your answer',
    type: f.type === 'email' ? 'email' : (isPhone(f) ? 'tel' : 'text'),
    inputmode: f.type === 'email' ? 'email' : (isPhone(f) ? 'tel' : (digitsOnly(f) ? 'numeric' : 'text')),
    autocomplete: f.type === 'email' ? 'email' : (isPhone(f) ? 'tel' : (f.name === 'full_name' ? 'name' : 'off')),
    max: f.maxLength,
  });
  chips(skip);
}

function showSizes(f, fitId) {
  const fit = fitsOf(f).find((x) => x.id === fitId);
  if (!fit) return showInput(f);
  current.sub = 'size';
  rich('chart', fitId);
  say(`Which ${fit.label.toLowerCase()} size?`);
  composer('line', { placeholder: 'Or type your size' });
  chips([
    ...fit.sizes.map((s) => ({ label: s.value, value: s.value })),
    { label: 'Change fit', value: 'fit:', style: 'quiet' },
  ]);
}

/** A wrong answer: say why, then put the very same question again. */
function retry(f, why) {
  say(`${why}. Let us try that again — ${promptFor(f)}`, { warn: true });
  askField(f, { again: true });
}

function onField(f, raw, fromChip) {
  let value = tidy(raw);

  if (f.type === 'choice') {
    if (fitsOf(f).length && fromChip && value.startsWith('fit:')) {
      const id = value.slice(4);
      return id ? showSizes(f, id) : askField(f);
    }
    if (!value && !f.required && fromChip) return accept(f, '');
    // Typed rather than tapped: taken if it names an option, in any case.
    const hit = f.options.find((o) => o.toLowerCase() === value.toLowerCase());
    if (!hit) {
      say(fitsOf(f).length
        ? 'I do not have that size. Please pick the fit, then a size from the list.'
        : 'That is not one of the choices. Please tap one of the options below.', { warn: true });
      return askField(f, { again: true });
    }
    return accept(f, hit);
  }

  if (f.type !== 'paragraph') value = value.replace(/\s+/g, ' ');
  if (!value && !f.required && fromChip) return accept(f, '');
  const wrong = checkField(f, value);
  if (wrong) return retry(f, wrong);
  return accept(f, value);
}

function accept(f, value) {
  const changed = state.answers[f.name] !== value;
  state.answers[f.name] = value;
  state.ask = null;
  prune();
  if (f.name === 'race_category' && value && changed) rich('jersey', value);
  next();
}

/* ---------- the receipt ---------- */

const MAX_UPLOAD = 4 * 1024 * 1024;
// What a photo may weigh before it is shrunk. Well past any phone camera.
const MAX_PHOTO_SOURCE = 40 * 1024 * 1024;
const UPLOAD_KINDS = {
  'image/webp': 'WebP', 'image/jpeg': 'JPG', 'image/png': 'PNG',
  'image/heic': 'HEIC', 'image/heif': 'HEIC', 'application/pdf': 'PDF',
};
const kb = (n) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const IMAGE_NAME = /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i;
const isImage = (file) => file.type.startsWith('image/') || (!file.type && IMAGE_NAME.test(file.name));

/** Through an <img> first: it honours rotation and copes with huge photos on iOS. */
async function decodeImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('not decodable'));
      img.src = url;
    });
    if (!img.naturalWidth) throw new Error('not decodable');
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (err) {
    URL.revokeObjectURL(url);
    if (typeof createImageBitmap !== 'function') throw err;
    const bmp = await createImageBitmap(file);
    return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close?.() };
  }
}

/**
 * Shrinks a photo to a 1400px edge before it is sent, as the form does:
 * WebP where the browser can encode one, JPEG where it cannot — which is
 * every browser on an iPhone. Anything it cannot handle is sent as it is.
 */
async function downscale(file) {
  if (!isImage(file)) return file;
  try {
    const pic = await decodeImage(file);
    const scale = Math.min(1, 1400 / Math.max(pic.width, pic.height));
    const w = Math.max(1, Math.round(pic.width * scale));
    const h = Math.max(1, Math.round(pic.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(pic.source, 0, 0, w, h);
    pic.release();

    const encode = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    const probe = await encode('image/webp', 0.62);
    const format = probe?.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
    const qualities = format === 'image/webp' ? [0.62, 0.52, 0.42, 0.34] : [0.72, 0.62, 0.52, 0.42];
    let best = null;
    for (const quality of qualities) {
      const blob = quality === 0.62 && format === 'image/webp' ? probe : await encode(format, quality);
      if (!blob || blob.type !== format) continue;
      if (!best || blob.size < best.size) best = blob;
      if (blob.size <= 700 * 1024) break;
    }
    if (!best) throw new Error('could not encode');
    return new File([best], file.name.replace(/\.[^.]+$/, '') + (format === 'image/webp' ? '.webp' : '.jpg'),
      { type: format, lastModified: Date.now() });
  } catch {
    return file;
  }
}

function attach(f) {
  quick.textContent = '';
  const label = document.createElement('label');
  label.className = 'cb-attach';
  label.innerHTML = `${ICON.clip}<span>Choose a photo or PDF</span>`;
  const picker = document.createElement('input');
  picker.type = 'file';
  // HEIC is left out on purpose: given only these, an iPhone converts a HEIC
  // photo to JPEG itself before handing it over.
  picker.accept = 'image/jpeg,image/png,image/webp,application/pdf';
  picker.setAttribute('aria-label', 'Choose your proof of payment');
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (file && !busy) upload(f, file);
  });
  label.append(picker);
  quick.append(label);
  toEnd();
}

async function upload(f, file) {
  const fail = (why) => {
    busy = false;
    status.remove();
    say(`${why} Please choose the file again.`, { warn: true });
    attach(f);
  };

  busy = true;
  quick.textContent = '';
  said(`Attached: ${file.name}`);
  const status = bubble('b', 'Preparing your file…');

  const photo = isImage(file);
  if (file.size > (photo ? MAX_PHOTO_SOURCE : MAX_UPLOAD)) {
    return fail(photo
      ? `That photo is ${kb(file.size)}, which is too large. A screenshot of the receipt works well.`
      : `That file is ${kb(file.size)}. I can only take files under 4 MB.`);
  }

  const sending = await downscale(file);
  const type = sending.type || (/\.hei[cf]$/i.test(sending.name) ? 'image/heic' : '');
  if (!UPLOAD_KINDS[type]) return fail('I can only take a JPG, PNG, WEBP or HEIC photo, or a PDF.');
  if (sending.size > MAX_UPLOAD) return fail(`That file is ${kb(sending.size)} — over the 4 MB limit.`);

  status.textContent = `Uploading… ${kb(sending.size)}`;
  toEnd();

  let res;
  try {
    res = await fetch('/api/drive-upload', {
      method: 'POST',
      // Encoded: a header can only carry Latin-1, and a file name often has more.
      headers: { 'Content-Type': type, 'X-Filename': encodeURIComponent(sending.name) },
      body: sending,
    });
  } catch {
    return fail('I could not reach the server, so the file was not uploaded.');
  }
  const data = await res.json().catch(() => ({}));
  const fileId = String(data.id || '');
  if (!res.ok || !data.ok || !fileId) {
    // fail() adds its own "choose the file again", so the server's is dropped.
    return fail(String(data.error || '').replace(/\s*Please try again\.?\s*$/i, '') || 'The upload did not go through.');
  }

  busy = false;
  status.remove();
  state.file = { name: file.name, size: data.size ?? sending.size };
  say(`Got it — your ${UPLOAD_KINDS[type]} receipt is uploaded.`);
  accept(f, fileId);
}

/* ---------- review and submit ---------- */

function shownValue(f) {
  const v = state.answers[f.name];
  if (f.type === 'file') return state.file ? `Uploaded — ${state.file.name}` : 'Uploaded';
  return v === '' ? '(skipped)' : v;
}

function review() {
  current = { type: 'review' };
  // Only the newest summary can be edited from; older ones are history.
  log.querySelectorAll('.cb-edit').forEach((b) => { b.disabled = true; });

  const wrap = document.createElement('div');
  const lead = document.createElement('p');
  lead.innerHTML = '<strong>Here is what I have.</strong> Please check it — tap Edit beside anything that is wrong.';
  const list = document.createElement('ul');
  list.className = 'cb-sum';
  for (const f of activeFields()) {
    const li = document.createElement('li');
    const text = document.createElement('div');
    text.className = 'cb-sum-t';
    const k = document.createElement('span');
    k.textContent = f.label;
    const v = document.createElement('b');
    v.textContent = shownValue(f);
    text.append(k, v);
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'cb-mini cb-edit';
    edit.dataset.name = f.name;
    edit.textContent = f.type === 'file' ? 'Replace' : 'Edit';
    edit.setAttribute('aria-label', `${edit.textContent} ${f.label}`);
    li.append(text, edit);
    list.append(li);
  }
  wrap.append(lead, list);
  bubble('b', wrap, 'cb-rich');

  composer('none');
  chips([{ label: 'Submit my registration', value: 'submit', style: 'primary' }]);
}

function editField(name) {
  if (busy || current?.type !== 'review') return;
  const f = fieldByName(name);
  if (!f) return;
  log.querySelectorAll('.cb-edit').forEach((b) => { b.disabled = true; });
  said(`${f.type === 'file' ? 'Replace' : 'Edit'}: ${f.label}`);
  state.ask = name;
  next();
}

/** Which question a line of the server's reply is about, if it names one. */
function fieldOfError(msg) {
  return SCHEMA.fields.find((f) => msg.startsWith(f.label) || (f.patternMessage && msg === f.patternMessage));
}

async function submit() {
  busy = true;
  quick.textContent = '';
  const status = bubble('b', 'Submitting your registration…');
  const fields = {};
  for (const f of activeFields()) fields[f.name] = state.answers[f.name] ?? '';

  const tryAgain = (why) => {
    busy = false;
    status.remove();
    current = { type: 'review' };
    say(`${why} Your answers are still here — nothing was lost.`, { warn: true });
    // The same id goes with the retry, so if the first attempt did reach the
    // server this one is answered with that registration, not a second.
    chips([{ label: 'Try again', value: 'submit', style: 'primary' }]);
  };

  let res;
  let data;
  try {
    res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...fields,
        [SCHEMA.agreement?.name || 'waiver_agreed']: true,
        [SCHEMA.privacy?.name || 'privacy_agreed']: true,
        source: 'chat',
        submission_id: state.submissionId,
        _hp: honeypot.value,
      }),
    });
    data = await res.json();
  } catch {
    return tryAgain('I could not reach the server just now.');
  }

  if (data?.ok) {
    busy = false;
    status.remove();
    return finished(data, fields);
  }

  if (Array.isArray(data?.errors) && data.errors.length) {
    busy = false;
    status.remove();
    // The server disagreed with an answer. Each one it names is asked again;
    // a complaint about nothing in particular just returns to the summary.
    const named = [];
    for (const msg of data.errors) {
      const f = fieldOfError(msg);
      say(msg, { warn: true });
      if (f) named.push(f);
    }
    for (const f of named) {
      delete state.answers[f.name];
      if (f.type === 'file') state.file = null;
    }
    if (data.uploadCleared) {
      for (const f of SCHEMA.fields.filter((x) => x.type === 'file')) {
        delete state.answers[f.name];
        state.file = null;
      }
    }
    return next();
  }

  return tryAgain(data?.error || 'Something went wrong on our side.');
}

function finished(data, fields) {
  current = { type: 'done' };
  const email = fields[SCHEMA.fields.find((f) => f.type === 'email')?.name];
  rich('done', data.ref, { keep: false });
  say(data.mailSent || data.mailQueued
    ? `A confirmation email is on its way to ${email}. Please keep your reference number — you will need it on race day.`
    : 'Your registration is saved, but the confirmation email could not be sent. Please keep your reference number and contact the organisers.',
    { keep: false });
  fill.style.width = '100%';
  track.setAttribute('aria-valuenow', '100');
  // Nothing of this registration is left behind in the tab.
  forget();
  composer('none');
  chips([{ label: 'Register another person', value: 'another', style: 'quiet' }]);
}

/* ---------- the conversation loop ---------- */

function answer(raw, shown, fromChip = false) {
  const text = String(raw ?? '');
  const c = current;
  if (!c || busy) return;

  if (c.type === 'restart') {
    said(shown || text);
    if (text === 'restart' || /\b(yes|start over|restart)\b/i.test(text)) return startOver();
    current = c.back;
    say('All right, let us carry on.');
    return next();
  }
  if (c.type === 'done') {
    if (text === 'another') { said(shown); return startOver(); }
    return;
  }
  if (c.type === 'failed') {
    if (text === 'reload') location.reload();
    return;
  }
  if (c.type === 'review') {
    if (text === 'submit' || /^\s*(submit|yes|ok|okay|send)\b/i.test(text)) {
      said(shown || text);
      return submit();
    }
    said(shown || text);
    return say('Tap "Submit my registration" when everything is right, or "Edit" beside an answer to change it.');
  }

  // An empty box sent by itself is not an answer to anything.
  if (!fromChip && !tidy(text)) return;
  said(shown || tidy(text));
  if (c.type === 'waiver' || c.type === 'privacy') return onConsent(c.type, tidy(text));
  if (c.type === 'field') return onField(c.field, text, fromChip);
}

function askRestart() {
  if (busy || !SCHEMA || current?.type === 'restart') return;
  if (current?.type === 'done') return startOver();
  current = { type: 'restart', back: current };
  say('Start over? Everything you have answered so far will be cleared.', { keep: false });
  composer('none');
  chips([
    { label: 'Yes, start over', value: 'restart', style: 'quiet' },
    { label: 'No, carry on', value: 'continue', style: 'primary' },
  ]);
}

function startOver() {
  forget();
  state = fresh();
  log.textContent = '';
  greet();
  next();
}

function greet() {
  say('Hello! I am the registration assistant for the Southville Run For A Cause 2026. I will ask for your details one at a time and register you at the end. It takes about three minutes.');
  if (SCHEMA && !SCHEMA.configured) {
    say('Preview mode: registration is not open yet, so nothing you send here will be recorded.', { warn: true });
  }
}

/* ---------- opening, closing, and the keyboard ---------- */

let started = false;

async function start() {
  if (started) return;
  started = true;
  const loading = bubble('b', 'One moment…');
  try {
    const res = await fetch('/api/schema');
    if (!res.ok) throw new Error(String(res.status));
    SCHEMA = await res.json();
  } catch {
    loading.remove();
    current = { type: 'failed' };
    bubble('b', 'I could not load the registration questions. Please check your connection and try again.', 'cb-warn');
    composer('none');
    chips([{ label: 'Try again', value: 'reload', style: 'primary' }]);
    return;
  }
  loading.remove();

  if (restored && (restored.waiver || Object.keys(restored.answers).length)) {
    prune();
    redraw();
    say('Welcome back — let us continue where you left off.', { keep: false });
  } else {
    state = fresh();
    greet();
  }
  next();
}

/**
 * On a phone the panel is the whole screen, and the keyboard takes a share
 * of it. Sizing the panel to what is left keeps the box above the keyboard
 * and the newest message in view, instead of trusting where iOS decides a
 * fixed element belongs while the keyboard is up.
 */
function fit() {
  const vv = window.visualViewport;
  const phone = window.matchMedia('(max-width: 600px)').matches;
  if (!vv || !phone || panel.hidden) {
    panel.style.height = '';
    panel.style.top = '';
    return;
  }
  panel.style.height = `${vv.height}px`;
  panel.style.top = `${vv.offsetTop}px`;
  toEnd();
}
window.visualViewport?.addEventListener('resize', fit);
window.visualViewport?.addEventListener('scroll', fit);
window.addEventListener('resize', fit);

function open() {
  panel.hidden = false;
  launch.hidden = true;
  launch.setAttribute('aria-expanded', 'true');
  document.documentElement.classList.add('cb-lock');
  fit();
  toEnd();
  start();
}
function close() {
  panel.hidden = true;
  launch.hidden = false;
  launch.setAttribute('aria-expanded', 'false');
  document.documentElement.classList.remove('cb-lock');
  fit();
  launch.focus({ preventScroll: true });
}

launch.addEventListener('click', open);
document.getElementById('cb-start')?.addEventListener('click', open);
panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

panel.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'close') return close();
  if (act === 'restart') return askRestart();

  const copy = e.target.closest('[data-copy]');
  if (copy) {
    const was = copy.textContent;
    const done = (ok) => {
      copy.textContent = ok ? 'Copied' : 'Press and hold to copy';
      setTimeout(() => { copy.textContent = was; }, 1600);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(copy.dataset.copy).then(() => done(true), () => done(false));
    else done(false);
    return;
  }

  const edit = e.target.closest('.cb-edit');
  if (edit && !edit.disabled) editField(edit.dataset.name);
});

compose.addEventListener('submit', (e) => {
  e.preventDefault();
  if (busy) return;
  const text = box.value;
  box.value = '';
  answer(text, '', false);
});
// Enter sends a long answer too; Shift+Enter is how a new line is typed.
area.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  compose.requestSubmit ? compose.requestSubmit() : compose.dispatchEvent(new Event('submit', { cancelable: true }));
});

if (document.body.hasAttribute('data-chat-open')) open();
