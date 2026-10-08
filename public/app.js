const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Field names are generated slugs ([a-z0-9_]), so escaping is normally a no-op.
// CSS.escape is not available everywhere, so fall back to escaping by hand.
const cssEsc = (s) =>
  (typeof CSS !== 'undefined' && CSS.escape)
    ? CSS.escape(s)
    : String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);

let SCHEMA = null;

// Set once the questions cannot be fetched: "Proceed" is then out of service
// for good, and the waiver gate below stops driving it.
let proceedBlocked = false;

const agreed = () => Boolean($('agree')?.checked);
const privacyAgreed = () => Boolean($('privacy-agree')?.checked);

// The key the server reads the acceptance under. /api/schema names it, so the
// wire name lives in lib/form-schema.js alone; the fallback only matters if
// the schema fetch has failed, in which case there is no form to submit.
const agreementKey = () => SCHEMA?.agreement?.name || 'waiver_agreed';

init();

async function init() {
  // The intro page stands on its own: none of it needs the schema, so it is
  // wired before the fetch rather than after. A failed fetch used to return
  // before this ran, leaving every button on the page dead — and the message
  // saying why written into #banner, which lives in the form view nobody can
  // see yet.
  wireShots($('race'));
  wireViews();
  wireCauses();
  wireWhy();
  wireAgreement();

  try {
    const res = await fetch('/api/schema');
    if (!res.ok) throw new Error(String(res.status));
    SCHEMA = await res.json();
  } catch {
    return schemaUnavailable();
  }

  // The hero wordmark is styled markup; only replace it if it is not static.
  const titleEl = $('title');
  if (titleEl && !titleEl.hasAttribute('data-static')) titleEl.textContent = SCHEMA.title;
  $('desc').textContent = SCHEMA.description || '';
  document.title = SCHEMA.title;

  if (!SCHEMA.configured) {
    const msg =
      '<strong>Preview mode.</strong> This form is not connected to Google Forms yet — ' +
      'the field ids in <code>lib/form-schema.js</code> are placeholders, so submissions ' +
      'are rejected. Run <code>npm run schema</code> or <code>npm run import</code> to connect it.';
    banner(msg, 'warn');
    const n = $('intro-notice');
    if (n) { n.innerHTML = msg; n.hidden = false; }
  }

  renderSections();
  wireEvents();
  wireSalaryDeduction();
  updateProgress();

  // Deep link straight to the form, and honour the back button.
  showView(location.hash === '#register' ? 'form' : 'intro', { silent: true });
}

/* ---------- views ---------- */

/**
 * The page is two screens: the event intro, and the registration itself.
 * Switching is client-side so there is only one deploy and one schema fetch.
 */
function showView(name, { silent = false } = {}) {
  const intro = $('view-intro');
  const form = $('view-form');
  if (!intro || !form) return;

  // Both consent gates hold for every way into the form — the button, a
  // #register deep link and the back button — not just the button click.
  // Turning someone back lands them on the box instead of the top of the
  // page, so the scroll and the focus below are left to nudgeAgreement().
  let toForm = name === 'form';
  const turnedBack = toForm && (!privacyAgreed() || !agreed());
  if (turnedBack) { toForm = false; name = 'intro'; }

  intro.hidden = toForm;
  form.hidden = !toForm;

  if (turnedBack) return nudgeAgreement();

  if (!silent) {
    const hash = toForm ? '#register' : '#';
    if (location.hash !== hash) history.pushState({ view: name }, '', hash);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // Move focus so keyboard and screen-reader users land in the new screen.
    (toForm ? $('form-h') : $('proceed'))?.focus({ preventScroll: true });
  } else {
    window.scrollTo({ top: 0 });
  }
}

/* ---------- "where does it go?" modal ---------- */

/**
 * Every picture on the site names its own file in the markup. This is the one
 * thing they need from script: a slot whose file is not there yet keeps its
 * place and says so, rather than rendering a broken-image icon. Used by the
 * beneficiary photos, the race poster, the bank details and the size chart.
 */
function wireShots(root) {
  root?.querySelectorAll('.shot img').forEach((img) => {
    const markMissing = () => img.closest('.shot')?.classList.add('missing');
    img.addEventListener('error', markMissing);
    // Cached failures can land before the listener is attached.
    if (img.complete && img.naturalWidth === 0) markMissing();
  });
}

function openModal(modal) {
  if (!modal || modal.open) return;
  if (typeof modal.showModal === 'function') modal.showModal();
  else modal.setAttribute('open', '');     // very old browsers: inline fallback
}

/**
 * Native <dialog> gives us the focus trap, Escape handling and focus restore
 * for free, so this only has to cover opening and the backdrop click.
 *
 * `openId` is optional: a dialog opened from script still wants Escape and the
 * backdrop wired, and having no button of its own is no reason to go without.
 */
function wireModal(modalId, openId, closeId) {
  const modal = $(modalId);
  if (!modal) return null;

  $(openId)?.addEventListener('click', () => openModal(modal));

  $(closeId)?.addEventListener('click', () => modal.close());

  // Clicking the backdrop closes; clicking the panel must not.
  modal.addEventListener('click', (e) => {
    if (e.target !== modal) return;        // clicks inside bubble from children
    const r = modal.getBoundingClientRect();
    const inside =
      e.clientX >= r.left && e.clientX <= r.right &&
      e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) modal.close();
  });

  return modal;
}

function wireCauses() {
  const modal = wireModal('causes-modal', 'causes-open', 'causes-close');
  wireShots(modal);
}

/* ---------- "why do we run?" modal ---------- */

function wireWhy() {
  wireModal('why-modal', 'why-open', 'why-close');
}

/* ---------- the waiver agreement ---------- */

/**
 * Nobody reaches the registration form until the Waiver of Liability has been
 * accepted on the intro page. schemaUnavailable() takes "Proceed" out of
 * service for good, so the gate stands aside once that has happened rather
 * than reviving a button that has nothing to open.
 */
function wireAgreement() {
  const privacy = $('privacy-agree');
  const waiver = $('agree');
  if (!privacy && !waiver) return;
  [privacy, waiver].filter(Boolean).forEach((box) => {
    box.addEventListener('change', () => {
      $('privacy-box')?.classList.remove('nudge');
      $('agree-box')?.classList.remove('nudge');
      syncProceed();
    });
  });
  syncProceed();
}

function syncProceed() {
  const proceed = $('proceed');
  if (!proceed || proceedBlocked) return;

  const privacyOk = privacyAgreed();
  const waiverOk = agreed();
  const ok = privacyOk && waiverOk;
  proceed.disabled = !ok;

  const fine = $('proceed-fine');
  if (fine) {
    fine.textContent = ok
      ? 'Takes about 3 minutes. Have your proof of payment ready.'
      : !privacyOk
        ? 'Please confirm the Data Privacy Advisory to continue.'
        : 'Please accept the Waiver of Liability to continue.';
  }
}

/** Point at the first confirmation someone still needs to make. */
function nudgeAgreement() {
  const box = privacyAgreed() ? $('agree-box') : $('privacy-box');
  if (!box) return;
  box.classList.remove('nudge');
  void box.offsetWidth;
  box.classList.add('nudge');
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  (privacyAgreed() ? $('agree') : $('privacy-agree'))?.focus({ preventScroll: true });
}

/* ---------- SISC salary deduction panel ---------- */

/**
 * Paying by payroll deduction needs four extra answers that nobody else has
 * to see, so they live in a pop-up rather than the main flow. The dialog sits
 * inside <form>, which means its answers travel with the submission whether
 * it happens to be open or closed — no shadow state to keep in sync.
 */
function wireSalaryDeduction() {
  const modal = $('sd-modal');
  if (!modal) return;

  // Whichever control the schema produced for the method question.
  document.querySelectorAll('[name="payment_method"]').forEach((el) =>
    el.addEventListener('change', () => onMethodChange()));

  $('sd-edit')?.addEventListener('click', openSd);
  $('sd-close')?.addEventListener('click', () => closeSd());
  $('sd-cancel')?.addEventListener('click', () => closeSd());
  $('sd-save')?.addEventListener('click', saveSd);

  // Enter inside the panel means "save these details", not "submit the whole
  // registration" — the inputs belong to the outer form, so without this the
  // browser would send a half-filled form.
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      saveSd();
    }
  });

  // Escape and the backdrop both close the dialog; either way the card
  // underneath has to tell the truth about what is still missing.
  modal.addEventListener('close', () => { refreshSdSummary(); updateProgress(); });
  modal.addEventListener('click', (e) => {
    if (e.target !== modal) return;
    const r = modal.getBoundingClientRect();
    const inside =
      e.clientX >= r.left && e.clientX <= r.right &&
      e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) closeSd();
  });

  refreshSdSummary();
}

function openSd() {
  const modal = $('sd-modal');
  if (!modal) return;
  sdError('');
  if (typeof modal.showModal === 'function') {
    if (!modal.open) modal.showModal();
  } else {
    modal.setAttribute('open', '');
  }
}

function closeSd() {
  const modal = $('sd-modal');
  if (!modal) return;
  if (typeof modal.close === 'function' && modal.open) modal.close();
  else modal.removeAttribute('open');
  refreshSdSummary();
  updateProgress();
}

/** Picked a method: open the panel for employees, clear it for everyone else. */
function onMethodChange() {
  refreshPaymentInfo();
  const employee = panelFields(SD_PANEL).some((f) => isActive(f));
  if (employee) {
    refreshSdSummary();
    openSd();
  } else {
    clearSd();
    closeSd();
  }
  updateProgress();
}

function clearSd() {
  for (const f of panelFields(SD_PANEL)) {
    const el = document.querySelector(`[name="${cssEsc(f.name)}"]`);
    if (el) el.value = '';
    setFieldState(f.name, '', '');
  }
  sdError('');
}

function saveSd() {
  const v = values();
  const fields = panelFields(SD_PANEL);
  let bad = 0;
  for (const f of fields) {
    const msg = checkField(f, v[f.name], v);
    if (msg) bad++;
    setFieldState(f.name, msg, v[f.name]);
  }
  if (bad) {
    sdError(`${bad} ${bad === 1 ? 'field needs' : 'fields need'} your attention before these details can be saved.`);
    $('sd-modal').querySelector('.field.invalid input')?.focus();
    return;
  }
  sdError('');
  closeSd();
}

function sdError(message) {
  const box = $('sd-error');
  if (!box) return;
  box.textContent = message;
  box.hidden = !message;
}

/** Keeps the card under the method chips in step with the panel's answers. */
function refreshSdSummary() {
  const box = $('sd-summary');
  if (!box) return;

  const v = values();
  const fields = panelFields(SD_PANEL);
  const employee = fields.some((f) => isActive(f, v));
  box.hidden = !employee;
  if (!employee) return;

  const complete = fields.every((f) => !checkField(f, v[f.name], v));
  box.classList.toggle('ready', complete);
  $('sd-badge').textContent = complete ? 'Details saved' : 'Needs details';
  $('sd-summary-text').textContent = complete
    ? fields.map((f) => v[f.name]).filter(Boolean).slice(0, 3).join(' · ')
    : 'Three equal salary deductions starting November 15, 2026. We need your employee details before you can submit.';
  $('sd-edit').textContent = complete ? 'Edit details' : 'Add details';
}

function wireViews() {
  $('proceed')?.addEventListener('click', () => showView('form'));
  $('back')?.addEventListener('click', () => showView('intro'));
  window.addEventListener('popstate', () => {
    showView(location.hash === '#register' ? 'form' : 'intro', { silent: true });
  });
}

/* ---------- rendering ---------- */

function groupBySection(fields) {
  const groups = [];
  const index = new Map();
  for (const f of fields) {
    const key = f.section || '';
    if (!index.has(key)) {
      index.set(key, { title: key, fields: [] });
      groups.push(index.get(key));
    }
    index.get(key).fields.push(f);
  }
  return groups;
}

const SD_PANEL = 'salary-deduction';
const panelFields = (panel) => SCHEMA.fields.filter((f) => f.panel === panel);

/**
 * Is this question actually being asked, given the answers so far?
 * Mirrors isActive() in lib/form-schema.js — the page and the server must
 * never disagree about which questions are required.
 */
function isActive(f, all) {
  const cond = f.showIf;
  if (!cond) return true;
  const current = ((all || values())[cond.field] || '').trim();
  if (cond.equals !== undefined) return current === cond.equals;
  if (cond.notEquals !== undefined) return current !== cond.notEquals;
  return current !== '';
}

function renderSections() {
  // Questions belonging to a pop-up panel are drawn there, not in the flow.
  const groups = groupBySection(SCHEMA.fields.filter((f) => !f.panel));
  const single = groups.length === 1 && !groups[0].title;

  $('sections').innerHTML = groups.map((g, i) => {
    const head = single ? '' : `
      <div class="section-head">
        <span class="step" aria-hidden="true">${i + 1}</span>
        <h2>${esc(g.title || 'Your details')}</h2>
      </div>`;
    return `<section class="section" data-section="${esc(g.title)}">
      ${head}
      <div class="section-body">${g.fields.map(renderField).join('')}</div>
    </section>`;
  }).join('');

  const sd = $('sd-fields');
  if (sd) sd.innerHTML = panelFields(SD_PANEL).map(renderField).join('');

  mountPaymentInfo();
  // Before mountJersey: the size guide carries the second way into the jersey
  // pop-up, and mountJersey wires it.
  mountSizeGuide();
  mountJersey();
  mountSdSummary();
}

/**
 * Drops the account details and the payment-method photos at the top of the
 * Payment section, so they are on screen while the fee is being settled
 * rather than buried on the intro page.
 */
/** Finds a rendered section by its schema title. */
function sectionEl(title) {
  // Matched on the dataset rather than an attribute selector: section titles
  // come from the schema and may contain quotes or an ampersand.
  return [...document.querySelectorAll('.section')]
    .find((el) => el.dataset.section === title) || null;
}

function mountPaymentInfo() {
  const tpl = $('tpl-payment-info');
  const body = sectionEl('Payment')?.querySelector('.section-body');
  if (!tpl || !body) return;

  body.prepend(tpl.content.cloneNode(true));
  wireShots(body);

  refreshPaymentInfo();

  $('acct-copy')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText($('acct-no').textContent.trim());
      label(btn, 'Copied');
      btn.classList.add('copied');
      setTimeout(() => { label(btn, 'Copy'); btn.classList.remove('copied'); }, 1600);
    } catch {
      label(btn, 'Press Ctrl+C');
    }
  });
}

const label = (btn, text) => {
  const el = btn.querySelector('.acct-copy-label');
  if (el) el.textContent = text; else btn.textContent = text;
};

/**
 * What a runner has to do next depends entirely on how they are paying, so
 * the payment card says one thing at a time: the tile for the chosen method
 * comes forward, the other steps back, and the note underneath — plus the
 * hint on the upload question — describe that method and no other.
 */
const PAYMENT_GUIDE = {
  'Bank transfer': {
    note: 'Deposit or transfer the fee to the PNB account above, then upload the deposit slip or transfer receipt below.',
  },
  'Employee': {
    note: 'Nothing to send. The fee is taken from your payroll in three equal deductions, starting November 15, 2026. Your authorisation above is the record, so there is no receipt to upload.',
  },
};

function refreshPaymentInfo() {
  const chosen = (values().payment_method || '').trim();

  document.querySelectorAll('.pay-shots .shot').forEach((tile) => {
    const mine = tile.dataset.method === chosen;
    // Nothing is dimmed until a method is picked — it is still on offer.
    tile.classList.toggle('on', !!chosen && mine);
    tile.classList.toggle('off', !!chosen && !mine);
  });

  // The PNB details are only what a bank transfer needs. They stay on the
  // page for anyone still deciding, but step back once another method is
  // chosen rather than competing with the instruction that does apply.
  const bank = document.querySelector('.bank-card');
  if (bank) bank.classList.toggle('off', !!chosen && chosen !== 'Bank transfer');

  const guide = PAYMENT_GUIDE[chosen];
  const note = $('pay-note');
  if (note) {
    note.textContent = guide
      ? guide.note
      : 'Choose your payment method below, then upload the receipt as your proof of payment.';
  }

}

/* ---------- shirt size guide ---------- */

/**
 * The shirt comes in two cuts, and which cut a size belongs to is carried by
 * the size string itself — there is no second answer for it. Everything here
 * reads the cuts out of the schema (lib/form-schema.js), so adding a size, a
 * whole new cut, or another measured column is a change there and nowhere
 * else: the tabs, the menu, the table and the brackets all build themselves
 * from the same list.
 */
const sizeField = () => SCHEMA?.fields.find((f) => f.name === 'shirt_size') || null;
const sizeFits = () => sizeField()?.sizeChart?.fits || [];
const fitById = (id) => sizeFits().find((f) => f.id === id) || null;
/** Which cut a size belongs to, or null for a size no chart claims. */
const fitOfSize = (size) =>
  sizeFits().find((f) => f.sizes.some((s) => s.value === size)) || null;
const sizeRow = (fit, size) => fit?.sizes.find((s) => s.value === size) || null;

/** The cut whose chart is on screen. Follows the answer once there is one. */
let shownFit = '';

/** 22.094 keeps its figures; 28 does not grow ".000" to match it. */
const num = (n) => String(Number(n));

/**
 * Drops the size guide inside the shirt-size question itself, so the
 * measurements are in front of the reader while they pick — not in a separate
 * card they have to go looking for.
 */
function mountSizeGuide() {
  const tpl = $('tpl-shirt-guide');
  const field = document.querySelector('.field[data-for="shirt_size"]');
  if (!tpl || !field) return;

  // Goes just before the error line, so a validation message stays next to
  // the control. A choice question wraps its own in a <fieldset>, so the
  // anchor decides the parent rather than the other way round.
  const err = field.querySelector('.err-msg');
  const parent = err?.parentNode || field;
  parent.insertBefore(tpl.content.cloneNode(true), err ?? null);

  buildFitTabs();

  // The chart rows are the other way to answer the question: reading the
  // measurements and picking a size are one movement rather than two, and
  // the <select> above stays the control that actually holds the answer.
  $('sg-rows')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.sg-pick');
    if (btn) chooseSize(btn.closest('tr')?.dataset.size || '');
  });

  // Whichever control the schema produced for the size question — twenty-one
  // sizes is well past the chip threshold, so it is a grouped <select>.
  document.querySelectorAll('[name="shirt_size"]').forEach((el) =>
    el.addEventListener('change', () => {
      // Answering from the menu turns the chart to the cut that was chosen,
      // so the two are never showing different things.
      const fit = fitOfSize((values().shirt_size || '').trim());
      if (fit && fit.id !== shownFit) showFit(fit.id);
      else refreshSizeGuide();
    }));

  // Artwork that is not there yet falls back to the outline, rather than
  // leaving a broken picture next to the measurements.
  $('sg-shirt')?.addEventListener('error', () => {
    const img = $('sg-shirt');
    img.hidden = true;
    document.querySelector('.sg-art')?.classList.add('is-ghost');
  });

  // Whichever cut is charted first is the one on screen until an answer says
  // otherwise. A schema with no chart at all still gets a wired-up guide.
  const first = sizeFits()[0]?.id;
  if (first) showFit(first); else refreshSizeGuide();
}

/** Writes a size into the real control, and tells the form it changed. */
function chooseSize(size) {
  const el = document.querySelector('[name="shirt_size"]');
  const f = sizeField();
  if (!el || !f || !size) return;
  el.value = size;
  // The form's own listeners do the rest — the progress bar, the guide, the
  // section tick — so picking from the chart and picking from the menu land
  // in exactly the same place.
  el.dispatchEvent(new Event('change', { bubbles: true }));

  // Except the answered tick, which everywhere else waits for the control to
  // be left. Nothing is going to blur a <select> that was never focused, and
  // a question that has just been answered should not still be reading as
  // outstanding.
  const all = values();
  setFieldState(f.name, checkField(f, all[f.name], all), all[f.name]);
}

/* ---------- the cut tabs ---------- */

function buildFitTabs() {
  const wrap = $('sg-fits');
  if (!wrap) return;

  wrap.innerHTML = sizeFits().map((f) => `
    <button type="button" class="sg-fit" role="tab" data-fit="${esc(f.id)}"
            id="sg-tab-${esc(f.id)}" aria-controls="sg-panel"
            aria-selected="false" tabindex="-1">
      <span class="sg-fit-name">${esc(f.label)}</span>
      <span class="sg-fit-sub">${esc(f.tagline)}</span>
    </button>`).join('');

  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('.sg-fit');
    if (btn) showFit(btn.dataset.fit);
  });

  // A tablist is expected to move under the arrow keys, with one tab stop for
  // the whole set — otherwise reaching the size menu means tabbing past every
  // cut on offer.
  wrap.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const fits = sizeFits();
    const at = fits.findIndex((f) => f.id === shownFit);
    const next = !Number.isFinite(step)
      ? (step < 0 ? 0 : fits.length - 1)
      : (at + step + fits.length) % fits.length;
    showFit(fits[next]?.id);
    $(`sg-tab-${fits[next]?.id}`)?.focus();
  });
}

/** Turns the guide to one cut: its tab, its columns, its rows, its brackets. */
function showFit(id) {
  const fit = fitById(id);
  if (!fit) return;
  shownFit = fit.id;

  document.querySelectorAll('.sg-fit').forEach((b) => {
    const on = b.dataset.fit === fit.id;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });

  const panel = $('sg-panel');
  if (panel) panel.setAttribute('aria-labelledby', `sg-tab-${fit.id}`);

  const note = $('sg-fit-note');
  if (note) note.textContent = fit.note || '';

  buildSizeTable(fit);
  buildMeasureNotes(fit);
  refreshSizeGuide();
}

/* ---------- the chart ---------- */

/** Draws one cut's chart: one row per size, one column per measurement. */
function buildSizeTable(fit) {
  const head = $('sg-head');
  const body = $('sg-rows');
  if (!head || !body) return;

  const unit = sizeField()?.sizeChart?.units === 'inches' ? '&Prime;' : '';
  // A figure is a measurement and takes the mark; a cross-reference like the
  // kids chart's "5XS" is a name and does not.
  const cell = (v) =>
    v == null ? '<span class="sg-none">&mdash;</span>'
      : typeof v === 'number' ? `${num(v)}${unit}` : esc(v);

  head.innerHTML = `<tr><th scope="col">Size</th>${
    fit.columns.map((c) => `<th scope="col">${esc(c.label)}</th>`).join('')
  }</tr>`;

  body.innerHTML = fit.sizes.map((s) => {
    const cells = fit.columns.map((c) => `<td>${cell(s[c.key])}</td>`).join('');
    return `<tr data-size="${esc(s.value)}">
      <th scope="row">
        <button type="button" class="sg-pick">${esc(s.value)}</button>
      </th>${cells}</tr>`;
  }).join('');

  // Short on purpose: the drawing beside it already shows what the chest
  // figure is and where it comes from, so the caption only has to say that
  // the rows can be tapped — which nothing else on the page says.
  const cap = $('sg-caption');
  if (cap) cap.textContent = `${fit.label} · tap a row to choose that size.`;
}

/**
 * The measuring instructions off the foot of the supplier's chart — but only
 * for the measurements this cut actually charts. The kids shirt has no body
 * length, so explaining how to measure one would be answering a question
 * nobody on that tab is holding.
 */
function buildMeasureNotes(fit) {
  const list = $('sg-how-list');
  const how = sizeField()?.sizeChart?.measure || {};
  if (!list) return;

  list.innerHTML = fit.columns
    .map((c) => how[c.key])
    .filter(Boolean)
    .map((m) => `<div class="sg-how-row">
      <dt>${esc(m.label)}</dt>
      <dd>${esc(m.text)}</dd>
    </div>`).join('');

  const note = $('sg-how-note');
  if (note) note.textContent = how.note || '';
}

/**
 * Points the guide at the answers so far: the chosen size's row comes forward
 * and its figures go on the brackets, and the shirt being measured is the one
 * for the chosen distance rather than a stand-in for some other garment.
 */
function refreshSizeGuide() {
  const guide = document.querySelector('.size-guide');
  if (!guide) return;

  const v = values();
  const size = (v.shirt_size || '').trim();
  const fit = fitById(shownFit);
  // Only claim a size on the chart that is on screen. Choosing "Kids 14" and
  // then reading the unisex tab must not light up its 5XS row: same chest,
  // different shirt, and that is the whole reason the two are kept apart.
  const row = sizeRow(fit, size);

  guide.querySelectorAll('#sg-rows tr').forEach((tr) => {
    const on = !!row && tr.dataset.size === size;
    tr.classList.toggle('is-on', on);
    // aria-current is what tells a screen reader which row is the answer;
    // the highlight alone says it only to people who can see it.
    if (on) tr.setAttribute('aria-current', 'true');
    else tr.removeAttribute('aria-current');
  });

  // The readout says what was chosen even while another tab is being read,
  // which is the one thing the highlighted row cannot do. The cut is named
  // beside it only when the size does not already say it: "M" needs telling
  // apart from a kids size, "Kids 16" plainly does not.
  const chosenFit = fitOfSize(size);
  const saysFit = chosenFit &&
    size.toLowerCase().startsWith(chosenFit.label.toLowerCase());
  const out = $('sg-chosen');
  if (out) {
    out.innerHTML = chosenFit
      ? `<span class="sg-chosen-size">${esc(size)}</span>${saysFit ? '' :
         `<span class="sg-chosen-fit">${esc(chosenFit.label)}</span>`}`
      : '<span class="sg-chosen-none">No size chosen yet</span>';
  }
  guide.classList.toggle('is-answered', !!chosenFit);

  // Inches get a ditto mark; anything else is spelled out in the caption and
  // left off the bracket, where there is no room to explain it.
  const unit = sizeField()?.sizeChart?.units === 'inches' ? '&Prime;' : '';
  const bracket = (el, n) => {
    if (el) el.innerHTML = n == null ? '&mdash;' : `${num(n)}${unit}`;
  };
  bracket($('sg-w'), row?.half);
  bracket($('sg-l'), row?.length);

  // The doubling is the step people miss, so the bracket shows its own
  // arithmetic rather than a number that has already been through it.
  const round = $('sg-w-round');
  if (round) {
    round.innerHTML = row?.chest == null ? '' : `&times;&nbsp;2 = ${num(row.chest)}${unit}`;
  }

  // A cut with no body length has no bracket for one: an empty measurement
  // hanging off the drawing reads as a figure that failed to load.
  const charts = (key) => !!fit?.columns.some((c) => c.key === key);
  guide.querySelector('.sg-length')?.toggleAttribute('hidden', !charts('length'));
  guide.classList.toggle('is-sized', !!row);

  const cat = (v.race_category || '').trim();
  const j = JERSEYS[cat];
  const img = $('sg-shirt');
  const art = guide.querySelector('.sg-art');
  if (img && art) {
    if (j) img.src = `${JERSEY_DIR}/${j.slug}-front.png`;
    else img.removeAttribute('src');
    img.hidden = !j;
    art.classList.toggle('is-ghost', !j);
  }
}

/* ---------- the race jersey, in 3D ---------- */

/**
 * Every distance runs in its own colourway, so the shirt is part of the answer
 * rather than decoration: pick 5K and the green one is what turns up, front
 * and back.
 *
 * The "3D" is CSS, not a mesh. The two flat views the printer supplies anyway
 * are hung back to back, and the gap between them is packed with darkened
 * copies of the same silhouette — so when the shirt turns, it has an edge to
 * show. That buys a solid-looking garment out of two PNGs, with no model to
 * commission and no library to ship.
 */

const JERSEY_DIR = '/shirt/jersey';

/**
 * Keyed by the race_category answers in lib/form-schema.js: add a distance
 * there and it needs an entry here, or its jersey quietly stops being shown.
 * The tint is an "r,g,b" triple because it is only ever used at low alpha, for
 * the glow behind the shirt — it sits near the artwork rather than matching it.
 */
const JERSEYS = {
  '1K':  { slug: '1k',  colourway: 'Classic white', tint: '150,152,172' },
  '3K':  { slug: '3k',  colourway: 'Signal red',    tint: '239,59,49' },
  '5K':  { slug: '5k',  colourway: 'Emerald green', tint: '20,145,82' },
  '10K': { slug: '10k', colourway: 'Deep violet',   tint: '109,42,176' },
};

/** How far a drag turns the shirt, in degrees per pixel. */
const TURN_RATE = 0.75;
/** A pointer that travelled less than this was a tap, not a turn. */
const TAP_SLOP = 6;

const motionOff = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** The two viewers on the page: the card under the chips, and the pop-up. */
const jerseyViews = { mini: null, big: null };
/** Distances whose jersey has already introduced itself unprompted. */
const jerseySeen = new Set();

/**
 * Builds one viewer into `root`. `onTurn` is called with 'front' or 'back'
 * whenever the side facing the reader changes, so controls elsewhere can
 * follow the shirt rather than the shirt having to know about them.
 */
function makeJersey(root, { onTurn } = {}) {
  const layers = Math.max(2, Number(root.dataset.layers) || 10);

  // The front silhouette is still used for the shallow "body" between the
  // printed faces. The supplied side view is then laid over that body at the
  // quarter-turns, facing the reader instead of disappearing edge-on.
  const edges = Array.from({ length: layers }, (_, i) => {
    const t = (i + 1) / (layers + 1);
    const lit = (0.6 - 0.34 * Math.sin(Math.PI * t)).toFixed(3);
    return `<img class="j-edge" alt="" draggable="false"
                 style="--z:${t.toFixed(4)};filter:brightness(${lit}) saturate(1.35)">`;
  }).join('');

  root.innerHTML = `
    <span class="j-floor" aria-hidden="true"></span>
    <div class="j-stage" tabindex="0" role="img" aria-label="Race jersey">
      <div class="j-spin">
        <span class="j-edges" aria-hidden="true">${edges}</span>
        <img class="j-face j-front" alt="" draggable="false">
        <img class="j-face j-side" alt="" draggable="false">
        <img class="j-face j-back" alt="" draggable="false">
      </div>
    </div>
    <svg class="j-ghost" viewBox="0 0 100 110" aria-hidden="true" fill="none"
         stroke="currentColor" stroke-width="3" stroke-linejoin="round">
      <path d="M50 9 30 15 8 27l8 20 12-5v58h44V42l12 5 8-20-22-12z"/>
      <path d="M38 12q12 14 24 0"/>
    </svg>
    <p class="j-note"></p>`;

  const stage = root.querySelector('.j-stage');
  const spin = root.querySelector('.j-spin');
  const front = root.querySelector('.j-front');
  const side = root.querySelector('.j-side');
  const back = root.querySelector('.j-back');
  const edgeEls = [...root.querySelectorAll('.j-edge')];
  const note = root.querySelector('.j-note');

  let cat = '';
  let ry = 0;
  let showing = 'front';
  let drag = null;

  /**
   * The side artwork is a supplied profile, so unlike a real mesh it cannot
   * be put on a perpendicular CSS plane (that plane would be edge-on too).
   * Instead it counter-rotates to face the reader exactly when the virtual
   * body reaches 90/270 degrees. The front/back planes remain real 3D faces.
   */
  const facing = () => {
    const n = ((ry % 360) + 360) % 360;
    if (n > 45 && n < 135) return 'side';
    if (n >= 135 && n <= 225) return 'back';
    if (n > 225 && n < 315) return 'side';
    return 'front';
  };

  const usable = () => cat && !root.classList.contains('is-missing');

  function describe() {
    const what = cat ? `${cat} race jersey` : 'Race jersey';
    stage.setAttribute('aria-label',
      `${what}, ${showing} view. Drag it, or use the arrow keys, to turn it round.`);
  }

  function apply() {
    spin.style.transform = `rotateY(${ry.toFixed(2)}deg)`;

    const radians = ry * Math.PI / 180;
    const cos = Math.abs(Math.cos(radians));
    const sin = Math.abs(Math.sin(radians));

    // Side art faces the reader while the parent continues to rotate. Mirroring
    // it on the return quarter makes both sides use the same supplied profile.
    const n = ((ry % 360) + 360) % 360;
    const mirror = n > 180 ? -1 : 1;
    side.style.transform =
      `rotateY(${-ry.toFixed(2)}deg) scaleX(${mirror})`;
    // The supplied side drawing is a real profile, so it should completely
    // replace the artificial depth stack at the quarter-turn. Otherwise the
    // dark front-silhouette copies remain visible as a black seam behind it.
    // Fade all three layers against each other so 45deg is still a believable
    // transition, while 90/270deg is cleanly just the supplied side artwork.
    const sideFade = Math.pow(sin, 3);
    const faceFade = Math.pow(cos, 2);
    side.style.opacity = sideFade.toFixed(3);
    side.style.filter = `brightness(${(0.72 + 0.28 * sin).toFixed(3)}) saturate(1.08)`;
    front.style.opacity = faceFade.toFixed(3);
    back.style.opacity = faceFade.toFixed(3);
    root.style.setProperty('--j-edge-opacity', Math.pow(cos, 3).toFixed(3));

    root.style.setProperty('--j-turn', cos.toFixed(3));

    const now = facing();
    if (now !== showing) { showing = now; describe(); onTurn?.(now); }
  }

  /** `instant` places the shirt without animating — for setup, not for turns. */
  function setTurn(deg, { instant = false } = {}) {
    if (instant) root.classList.add('is-still');
    ry = deg;
    apply();
    if (instant) requestAnimationFrame(() => root.classList.remove('is-still'));
  }

  /** Turns to a named view the short way round from wherever it is now. */
  function face(which, opts) {
    if (which === 'side') {
      const targets = [90, 270];
      const distance = (target) => {
        const delta = ((target - ry + 540) % 360) - 180;
        return Math.abs(delta);
      };
      const target = targets.reduce((a, b) => distance(a) <= distance(b) ? a : b);
      setTurn(target + 360 * Math.round((ry - target) / 360), opts);
      return;
    }
    const deg = which === 'back' ? 180 : 0;
    setTurn(deg + 360 * Math.round((ry - deg) / 360), opts);
  }

  const lean = (deg) => { stage.style.transform = `rotateX(${deg.toFixed(2)}deg)`; };

  front.addEventListener('error', () => {
    root.classList.add('is-missing');
    note.textContent = 'Jersey artwork coming soon.';
  });

  stage.addEventListener('pointerdown', (e) => {
    if (!usable()) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, from: ry, moved: 0 };
    stage.setPointerCapture(e.pointerId);
    root.classList.add('is-turning');
    lean(0);
  });

  stage.addEventListener('pointermove', (e) => {
    if (!drag) {
      if (usable() && e.pointerType === 'mouse' && !motionOff()) {
        const box = stage.getBoundingClientRect();
        lean((0.5 - (e.clientY - box.top) / box.height) * 11);
      }
      return;
    }
    if (e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    drag.moved = Math.max(drag.moved, Math.abs(dx), Math.abs(e.clientY - drag.y));
    setTurn(drag.from + dx * TURN_RATE);
  });

  const release = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const { moved } = drag;
    drag = null;
    root.classList.remove('is-turning');
    face(moved < TAP_SLOP ? (showing === 'front' ? 'back' : 'front') : facing());
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);
  stage.addEventListener('pointerleave', () => { if (!drag) lean(0); });

  stage.addEventListener('keydown', (e) => {
    if (!usable()) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setTurn(ry + (e.key === 'ArrowRight' ? 45 : -45));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      face(showing === 'front' ? 'back' : 'front');
    }
  });

  /** Points the viewer at a distance's artwork; '' empties it. */
  function show(next) {
    cat = JERSEYS[next] ? next : '';
    const j = JERSEYS[cat];
    root.classList.toggle('is-empty', !j);
    root.classList.remove('is-missing');
    note.textContent = '';
    lean(0);

    if (!j) {
      [front, side, back, ...edgeEls].forEach((img) => img.removeAttribute('src'));
      return;
    }

    const art = (view) => `${JERSEY_DIR}/${j.slug}-${view}.png`;
    front.src = art('front');
    side.src = art('side');
    back.src = art('back');
    edgeEls.forEach((img) => { img.src = art('front'); });
    root.style.setProperty('--j-tint', j.tint);
    face('front', { instant: true });
    describe();
  }

  function reveal() {
    face('front', { instant: true });
    if (motionOff()) return;
    setTurn(ry - 40, { instant: true });
    requestAnimationFrame(() => requestAnimationFrame(() => face('front')));
  }

  show('');
  return { show, face, reveal, focus: () => stage.focus({ preventScroll: true }) };
}

/**
 * Drops the jersey card into the race-category question and wires the pop-up.
 * The dialog itself is static markup, so only the card has to be cloned.
 */
function mountJersey() {
  const tpl = $('tpl-jersey');
  const field = document.querySelector('.field[data-for="race_category"]');
  if (!tpl || !field) return;

  const err = field.querySelector('.err-msg');
  (err?.parentNode || field).insertBefore(tpl.content.cloneNode(true), err ?? null);

  const mini = $('jersey-mini');
  if (mini) jerseyViews.mini = makeJersey(mini);

  const big = $('jersey-big');
  const faceBtns = [...document.querySelectorAll('.jersey-facebtn')];
  if (big) {
    jerseyViews.big = makeJersey(big, {
      onTurn: (side) => faceBtns.forEach((b) => {
        const on = b.dataset.face === side;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', String(on));
      }),
    });
    faceBtns.forEach((b) =>
      b.addEventListener('click', () => jerseyViews.big.face(b.dataset.face)));
  }

  // No openId: both buttons want the dialog set up before it is shown, so the
  // opening is ours. Escape and the backdrop still come from wireModal.
  wireModal('jersey-modal', null, 'jersey-close');
  $('jersey-open')?.addEventListener('click', openJersey);
  $('size-jersey')?.addEventListener('click', openJersey);

  // Whichever control the schema produced for the distance question.
  document.querySelectorAll('[name="race_category"]').forEach((el) =>
    el.addEventListener('change', onCategoryChange));

  refreshJersey();
}

function openJersey() {
  const modal = $('jersey-modal');
  if (!modal) return;
  refreshJersey();
  openModal(modal);
  jerseyViews.big?.reveal();
  // Focus lands on the shirt rather than the close button, so the arrow keys
  // do the obvious thing and the label describes what is on screen.
  jerseyViews.big?.focus();
}

/**
 * Picking a distance shows the shirt that comes with it — once per distance.
 * Announcing itself every time somebody changed their mind would be a pop-up
 * in the bad sense; never announcing itself would leave the whole thing behind
 * a button nobody presses.
 */
function onCategoryChange() {
  refreshJersey();
  // The guide draws its brackets against this distance's shirt, so it moves
  // with the distance as well as with the size.
  refreshSizeGuide();
  const cat = (values().race_category || '').trim();
  if (JERSEYS[cat] && !jerseySeen.has(cat)) {
    jerseySeen.add(cat);
    openJersey();
  }
}

/** Points every part of the page that mentions the jersey at the chosen one. */
function refreshJersey() {
  const cat = (values().race_category || '').trim();
  const j = JERSEYS[cat];

  jerseyViews.mini?.show(cat);
  jerseyViews.big?.show(cat);

  $('jersey-card')?.classList.toggle('is-set', !!j);

  const name = $('jersey-name');
  if (name) {
    name.innerHTML = j
      ? `${esc(cat)} <span class="jersey-colour">${esc(j.colourway)}</span>`
      : 'Choose a distance';
  }

  const hint = $('jersey-hint');
  if (hint) {
    hint.textContent = j
      ? 'Tap the shirt to turn it round, or open it in 3D for a closer look.'
      : 'Each distance has its own colourway. Pick one above to see the shirt.';
  }

  $('jersey-open')?.toggleAttribute('hidden', !j);
  $('size-jersey')?.toggleAttribute('hidden', !j);

  const sizeCat = $('size-jersey-cat');
  if (sizeCat) sizeCat.textContent = cat || 'race';

  const title = $('jersey-title');
  if (title) title.textContent = j ? `${cat} race jersey` : 'Race jersey';

  const sub = $('jersey-sub');
  if (sub) sub.textContent = j ? `${j.colourway} · front, side and back` : 'Front, side and back';
}

/**
 * The card that sits under the payment-method chips once "Employee" is
 * chosen: it reports whether the salary-deduction panel has been filled in,
 * and is the way back into it.
 */
function mountSdSummary() {
  const anchor = document.querySelector('.field[data-for="payment_method"]');
  if (!anchor || !panelFields(SD_PANEL).length) return;

  const box = document.createElement('div');
  box.className = 'sd-summary';
  box.id = 'sd-summary';
  box.hidden = true;
  box.innerHTML = `
    <div class="sd-summary-main">
      <span class="sd-badge" id="sd-badge">Needs details</span>
      <p class="sd-summary-text" id="sd-summary-text"></p>
    </div>
    <button type="button" class="btn-ghost sd-edit" id="sd-edit">Add details</button>`;
  anchor.after(box);
}

function renderField(f) {
  const star = f.required
    ? '<span class="req" aria-hidden="true">*</span>'
    : '<span class="optional">optional</span>';
  const help = f.help ? `<p class="help" id="h_${esc(f.name)}">${esc(f.help)}</p>` : '';
  const describedBy = [f.help ? `h_${f.name}` : '', `e_${f.name}`].filter(Boolean).join(' ');
  const id = `f_${esc(f.name)}`;

  // Choice: chips when the options are few and short, a select when there are many.
  if (f.type === 'choice' && f.options?.length) {
    const compact = f.options.length <= 7 && f.options.every((o) => String(o).length <= 22);
    if (compact) {
      const chips = f.options.map((o, i) => `
        <label class="chip">
          <input type="radio" name="${esc(f.name)}" value="${esc(o)}" id="${id}_${i}"
                 ${f.required ? 'required' : ''}>
          <span>${esc(o)}</span>
        </label>`).join('');
      return `<div class="field" data-for="${esc(f.name)}">
        <fieldset aria-describedby="${esc(describedBy)}">
          <legend class="q">${esc(f.label)}${star}</legend>
          ${help}
          <div class="chips">${chips}</div>
          <p class="err-msg" id="e_${esc(f.name)}"></p>
        </fieldset>
      </div>`;
    }
    // Grouped when the schema says so — twenty-one shirt sizes in one flat
    // list is a scroll with nothing to steer by, and the browser's own
    // <optgroup> headings cost nothing and work in every picker, including
    // the full-screen wheel a phone puts up.
    const opt = (o) => `<option value="${esc(o)}">${esc(o)}</option>`;
    const opts = f.optionGroups?.length
      ? f.optionGroups.map((g) =>
          `<optgroup label="${esc(g.label)}">${g.options.map(opt).join('')}</optgroup>`).join('')
      : f.options.map(opt).join('');
    return field(f, id, star, help, describedBy,
      `<select name="${esc(f.name)}" id="${id}" aria-describedby="${esc(describedBy)}">
         <option value="">Choose an option</option>${opts}
       </select>`);
  }

  if (f.type === 'paragraph') {
    return field(f, id, star, help, describedBy,
      `<textarea name="${esc(f.name)}" id="${id}" rows="3" placeholder="Your answer"
                 aria-describedby="${esc(describedBy)}"></textarea>`);
  }

  // File upload: the picked file goes to Vercel Blob, and the resulting URL
  // is what actually travels to the Google Form in the hidden input.
  if (f.type === 'file') {
    return field(f, id, star, help, describedBy, `
      <input type="hidden" name="${esc(f.name)}" id="${id}" value="">
      <label class="drop" data-drop="${esc(f.name)}">
        <input type="file" id="${id}_picker" class="file-input"
               accept="image/jpeg,image/png,image/webp,application/pdf"
               aria-describedby="${esc(describedBy)}">
        <span class="drop-icon" aria-hidden="true">&#8679;</span>
        <span class="drop-main">Choose a file or drag it here</span>
        <span class="drop-sub">JPG, PNG, WEBP or PDF · up to 4&nbsp;MB</span>
      </label>
      <div class="upload" id="${id}_state" hidden>
        <div class="upload-row">
          <span class="upload-thumb" id="${id}_thumb" aria-hidden="true"></span>
          <span class="upload-meta">
            <span class="upload-name" id="${id}_name"></span>
            <span class="upload-status" id="${id}_status"></span>
          </span>
          <button type="button" class="btn-ghost" id="${id}_remove">Remove</button>
        </div>
        <div class="upload-track"><div class="upload-fill" id="${id}_bar"></div></div>
      </div>`);
  }

  const type = f.type === 'email' ? 'email' : (isPhone(f) ? 'tel' : 'text');
  const max = f.maxLength ? ` maxlength="${f.maxLength}"` : '';
  const mode = f.type === 'email' ? 'email' : (isPhone(f) ? 'tel' : 'text');
  const auto = f.type === 'email' ? 'email' : (isPhone(f) ? 'tel' : 'on');
  // A schema placeholder is a worked example ("DELA CRUZ, JUAN"); without one
  // the generic prompt still tells the reader the box is theirs to fill.
  const hint = f.placeholder || 'Your answer';
  return field(f, id, star, help, describedBy,
    `<input type="${type}" name="${esc(f.name)}" id="${id}"${max}
            inputmode="${mode}" autocomplete="${auto}" placeholder="${esc(hint)}"
            aria-describedby="${esc(describedBy)}">`);
}

function field(f, id, star, help, describedBy, control) {
  return `<div class="field" data-for="${esc(f.name)}">
    <label class="q" for="${id}">${esc(f.label)}${star}</label>
    ${help}
    ${control}
    <p class="err-msg" id="e_${esc(f.name)}"></p>
  </div>`;
}

// "Emergency contact name" is a name, not a number: the keyword test alone
// matched it and handed mobile users a numeric keypad, so a label that asks for
// a name is excluded before the phone keywords are considered at all.
const isPhone = (f) => /number|phone|contact|mobile/i.test(f.label)
  && !/name/i.test(f.label) && f.type !== 'email';

/* ---------- validation ---------- */

function values() {
  return Object.fromEntries(new FormData($('form')).entries());
}

/**
 * Mirrors the server rules so people get feedback before a round-trip.
 * `all` is the full answer map; pass it so a question that is not currently
 * being asked is never reported as missing.
 */
function checkField(f, v, all) {
  if (all && !isActive(f, all)) return '';
  const value = (v || '').trim();
  
  if (f.type === 'file') {
    // UPDATED FILE VALIDATION: Accepts IDs or full URLs, rejects empty/undefined strings
    if (!value || value === 'undefined' || value === 'null') {
      return f.required ? 'Please upload your proof of payment' : '';
    }
    return value.length > 15 ? '' : 'The upload did not complete. Please try again';
  }
  
  if (f.required && !value) return 'This question is required';
  if (!value) return '';
  if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return 'Enter a valid email address';
  }
  if (f.pattern) {
    // Compiled once per field rather than on every keystroke.
    f._re ||= new RegExp(f.pattern);
    if (!f._re.test(value)) return f.patternMessage || 'That is not in the expected format';
  }
  if (f.maxLength && value.length > f.maxLength) {
    return `Keep this under ${f.maxLength} characters`;
  }
  if (f.type === 'choice' && f.options?.length && !f.options.includes(value)) {
    return `Choose one of: ${f.options.join(', ')}`;
  }
  return '';
}

function setFieldState(name, message, filled) {
  const el = document.querySelector(`.field[data-for="${cssEsc(name)}"]`);
  if (!el) return false;
  el.classList.toggle('invalid', !!message);
  el.classList.toggle('done', !message && !!filled);
  const p = el.querySelector('.err-msg');
  if (p) p.textContent = message || '';
  el.querySelectorAll('input,select,textarea').forEach((c) => {
    if (message) c.setAttribute('aria-invalid', 'true');
    else c.removeAttribute('aria-invalid');
  });
  return true;
}

function clearErrors() {
  $('banner').hidden = true;
  document.querySelectorAll('.field.invalid').forEach((el) => {
    el.classList.remove('invalid');
    const p = el.querySelector('.err-msg');
    if (p) p.textContent = '';
  });
}

/* ---------- progress ---------- */

function updateProgress() {
  const v = values();
  // Choosing "Employee" adds the salary-deduction questions to the count,
  // and switching away from it takes them back out.
  const req = SCHEMA.fields.filter((f) => f.required && isActive(f, v));
  if (!req.length) { $('progress-card').hidden = true; return; }

  const done = req.filter((f) => !checkField(f, v[f.name], v)).length;
  const pct = Math.round((done / req.length) * 100);

  $('progress-card').hidden = false;
  $('progress-label').textContent = `${done} of ${req.length} required answers`;
  $('progress-pct').textContent = `${pct}%`;
  $('fill').style.width = `${pct}%`;
  $('track').setAttribute('aria-valuenow', String(pct));

  showOnlyActiveFields(v);
  markCompleteSections(v);
}

/**
 * Takes a question off the page entirely while it does not apply — an
 * employee paying by payroll deduction has no receipt to show, so being
 * asked for one at all is the confusing part, not being asked to skip it.
 */
function showOnlyActiveFields(v) {
  for (const f of SCHEMA.fields) {
    if (!f.showIf || f.panel) continue;      // panel questions live in a dialog
    const el = document.querySelector(`.field[data-for="${cssEsc(f.name)}"]`);
    if (!el) continue;

    const active = isActive(f, v);
    if (el.hidden === !active) continue;      // already in the right state
    el.hidden = !active;

    // Don't leave a receipt attached to a registration that no longer wants
    // one: it would never be recorded, and seeing it again on switching back
    // implies it was kept.
    if (!active) uploadResetters.get(f.name)?.();
  }

  // The rule under the final question of a section is drawn by :last-child,
  // which does not know about hidden siblings.
  document.querySelectorAll('.section-body').forEach((body) => {
    const fields = [...body.querySelectorAll('.field')];
    fields.forEach((el) => el.classList.remove('last-shown'));
    fields.filter((el) => !el.hidden).at(-1)?.classList.add('last-shown');
  });
}

/**
 * A section head shows a tick once nothing in it is outstanding, so a long
 * form can be scanned for what is left rather than re-read. An unanswered
 * optional question does not hold a section back.
 */
function markCompleteSections(v) {
  const state = new Map();
  for (const f of SCHEMA.fields) {
    if (!isActive(f, v)) continue;
    const key = f.section || '';
    const s = state.get(key) || { total: 0, done: 0 };
    s.total++;
    if (!checkField(f, v[f.name], v)) s.done++;
    state.set(key, s);
  }
  document.querySelectorAll('.section[data-section]').forEach((el) => {
    const s = state.get(el.dataset.section);
    el.classList.toggle('complete', !!s && s.total > 0 && s.done === s.total);
  });
}

/* ---------- events ---------- */

function wireEvents() {
  const form = $('form');

  // Validate a field when the user leaves it, but never nag before then.
  form.addEventListener('blur', (e) => {
    const wrap = e.target.closest?.('.field');
    if (!wrap) return;
    const f = SCHEMA.fields.find((x) => x.name === wrap.dataset.for);
    if (!f) return;
    const all = values();
    const v = all[f.name];
    setFieldState(f.name, checkField(f, v, all), v);
  }, true);

  // Clear an error as soon as the answer becomes valid again.
  form.addEventListener('input', (e) => {
    const wrap = e.target.closest?.('.field');
    if (wrap?.classList.contains('invalid')) {
      const f = SCHEMA.fields.find((x) => x.name === wrap.dataset.for);
      if (f) {
        const all = values();
        const v = all[f.name];
        if (!checkField(f, v, all)) setFieldState(f.name, '', v);
      }
    }
    updateProgress();
  });
  form.addEventListener('change', updateProgress);

  SCHEMA.fields.filter((f) => f.type === 'file').forEach(wireUpload);

  form.addEventListener('submit', onSubmit);

  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('ref').textContent);
      $('copy').textContent = 'Copied';
      setTimeout(() => ($('copy').textContent = 'Copy'), 1600);
    } catch {
      $('copy').textContent = 'Press Ctrl+C';
    }
  });

  $('again').addEventListener('click', (e) => {
    e.preventDefault();
    form.reset();
    resetUploads();
    document.querySelectorAll('.field').forEach((el) => el.classList.remove('invalid', 'done'));
    document.querySelectorAll('.err-msg').forEach((p) => (p.textContent = ''));
    refreshSdSummary();
    // A fresh runner is a fresh distance: empty the jersey card, and let the
    // shirt introduce itself again rather than staying on the last one's.
    jerseySeen.clear();
    refreshJersey();
    refreshSizeGuide();
    $('done').hidden = true;
    form.hidden = false;
    $('progress-card').hidden = false;
    updateProgress();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

/* ---------- file upload ---------- */

const MAX_UPLOAD = 4 * 1024 * 1024;
const kb = (n) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// Each file field registers a reset callback, so the form can clear all of
// them at once or drop just the one whose question stopped being asked.
const uploadResetters = new Map();
function resetUploads() {
  uploadResetters.forEach((fn) => fn());
}

/**
 * Shrinks a large photo in the browser so a phone camera shot does not blow
 * past the request limit. Returns the original if it is already small,
 * cannot be decoded, or is not an image.
 */
async function downscale(file) {
  // Payment receipts are deliberately normalised in the browser before they
  // ever reach Blob. Canvas/WebP strips camera metadata and gives us a much
  // smaller, predictable image while keeping the receipt readable.
  if (!file.type.startsWith('image/')) return file;

  try {
    const bmp = await createImageBitmap(file);
    const max = 1400;
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();

    // Prefer a very small receipt, but step down quality gradually so text and
    // QR/barcode details remain usable. The smallest successful result wins.
    const qualities = [0.62, 0.52, 0.42, 0.34];
    const target = 700 * 1024;
    let best = null;

    for (const quality of qualities) {
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, 'image/webp', quality)
      );
      if (!blob) continue;
      if (!best || blob.size < best.size) best = blob;
      if (blob.size <= target) break;
    }

    if (!best) throw new Error('WebP encoding is unavailable');

    return new File(
      [best],
      file.name.replace(/\.[^.]+$/, '') + '.webp',
      { type: 'image/webp', lastModified: Date.now() }
    );
  } catch {
    // If the browser cannot decode/encode this image (notably some HEIC
    // variants), leave it untouched so the server can give a clear error.
    return file;
  }
}

function wireUpload(f) {
  const id = `f_${f.name}`;
  const hidden = $(id);
  const picker = $(`${id}_picker`);
  const drop = document.querySelector(`[data-drop="${cssEsc(f.name)}"]`);
  const state = $(`${id}_state`);
  const bar = $(`${id}_bar`);
  const status = $(`${id}_status`);
  const nameEl = $(`${id}_name`);
  const thumb = $(`${id}_thumb`);
  if (!hidden || !picker) return;

  let objectUrl = null;

  const reset = () => {
    hidden.value = '';
    picker.value = '';
    state.hidden = true;
    drop.hidden = false;
    bar.style.width = '0%';
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    thumb.style.backgroundImage = '';
    thumb.textContent = '';
    updateProgress();
  };

  uploadResetters.set(f.name, reset);

  $(`${id}_remove`).addEventListener('click', () => {
    reset();
    setFieldState(f.name, '', '');
  });

  async function handle(file) {
    if (!file) return;

    if (file.size > MAX_UPLOAD * 3) {
      setFieldState(f.name, `That file is ${kb(file.size)}, which is too large to upload.`, '');
      return;
    }

    drop.hidden = true;
    state.hidden = false;
    nameEl.textContent = file.name;
    status.textContent = 'Preparing…';
    status.className = 'upload-status';
    bar.style.width = '8%';
    setFieldState(f.name, '', '');

    const sending = await downscale(file);

    if (sending.type.startsWith('image/') && sending.type !== 'image/webp') {
      status.textContent = 'This image could not be converted to WebP. Please use JPG, PNG or WEBP.';
      status.className = 'upload-status bad';
      bar.style.width = '0%';
      setFieldState(f.name, 'Please use a JPG, PNG or WEBP image.', '');
      return;
    }

    if (sending.type.startsWith('image/')) {
      objectUrl = URL.createObjectURL(sending);
      thumb.style.backgroundImage = `url(${objectUrl})`;
    } else {
      thumb.textContent = 'PDF';
    }

    if (sending.size > MAX_UPLOAD) {
      status.textContent = `Too large (${kb(sending.size)}). Please use a smaller file.`;
      status.className = 'upload-status bad';
      bar.style.width = '0%';
      setFieldState(f.name, 'That file is too large. Please keep it under 4 MB.', '');
      return;
    }

    status.textContent = `Uploading… ${kb(sending.size)}`;
    bar.style.width = '35%';

    try {
      const res = await fetch('/api/drive-upload', {
        method: 'POST',
        headers: { 'Content-Type': sending.type, 'X-Filename': sending.name },
        body: sending,
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        status.textContent = data.error || 'Upload failed. Please try again.';
        status.className = 'upload-status bad';
        bar.style.width = '0%';
        setFieldState(f.name, data.error || 'Upload failed. Please try again.', '');
        return;
      }
      const rawResponse = data.url || data.id || data.fileId || data.file_id || '';
      
      // Extract ONLY the Drive ID, stripping away the "/api/receipt?id=" part if it exists
      const idMatch = rawResponse.match(/id=([a-zA-Z0-9_-]+)/);
      const cleanId = idMatch ? idMatch[1] : rawResponse;
      
      // Build the final, clean Drive URL
      const finalUrl = cleanId.startsWith('http') 
        ? cleanId 
        : `https://drive.google.com/file/d/${cleanId}/view?usp=sharing`;

      hidden.value = finalUrl;
      bar.style.width = '100%';
      status.textContent = `Uploaded · ${kb(data.size ?? sending.size)} WebP`;
      status.className = 'upload-status good';
      setFieldState(f.name, '', finalUrl);
      updateProgress();
    } catch {
      status.textContent = 'Network error. Please try again.';
      status.className = 'upload-status bad';
      bar.style.width = '0%';
      setFieldState(f.name, 'Network error while uploading. Please try again.', '');
    }
  }

  picker.addEventListener('change', () => handle(picker.files?.[0]));

  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => handle(e.dataTransfer?.files?.[0]));
}

/**
 * The questions could not be fetched, so there is no form to show. Say so on
 * the intro page — where the reader actually is — and take "Proceed" out of
 * service rather than sending them to an empty form. The rest of the page is
 * still worth reading: the date, the venue, the causes, the categories.
 */
function schemaUnavailable() {
  proceedBlocked = true;

  const msg =
    '<strong>The registration form could not be loaded.</strong> ' +
    'Please refresh the page. If it keeps happening, email us at the address below.';

  banner(msg);
  const n = $('intro-notice');
  if (n) { n.className = 'banner warn'; n.innerHTML = msg; n.hidden = false; }

  const proceed = $('proceed');
  if (proceed) {
    proceed.disabled = true;
    proceed.querySelector('span').textContent = 'Registration unavailable';
  }
  const fine = $('proceed-fine');
  if (fine) fine.textContent = 'Please refresh the page to try again.';
}

function banner(html, kind = '') {
  const b = $('banner');
  b.className = 'banner' + (kind ? ' ' + kind : '');
  b.innerHTML = html;
  b.hidden = false;
}

function focusFirstInvalid() {
  // Scoped to the visible flow: a panel field lives in a dialog that may be shut.
  const el = document.querySelector('#sections .field.invalid');
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.querySelector('input,select,textarea')?.focus({ preventScroll: true });
}

async function onSubmit(e) {
  e.preventDefault();
  clearErrors();

  const v = values();
  let bad = 0;
  let badInPanel = 0;
  for (const f of SCHEMA.fields) {
    const msg = checkField(f, v[f.name], v);
    if (msg) { bad++; if (f.panel) badInPanel++; }
    setFieldState(f.name, msg, v[f.name]);
  }
  refreshSdSummary();
  if (bad) {
    banner(`<strong>${bad} ${bad === 1 ? 'answer needs' : 'answers need'} your attention.</strong>
            Please check the highlighted ${bad === 1 ? 'question' : 'questions'} below.`);
    // An unanswered panel question sits behind a closed dialog, so scrolling
    // to it would land on nothing. Reopen the panel instead.
    if (badInPanel && bad === badInPanel) openSd();
    else focusFirstInvalid();
    return;
  }

  const btn = $('submit');
  btn.disabled = true;
  btn.classList.add('loading');
  btn.querySelector('.btn-label').textContent = 'Submitting…';

  let data;
  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The waiver ticked on the intro page travels with the answers: the
      // server refuses a registration without it, and records it as proof.
      body: JSON.stringify({ ...v, [agreementKey()]: agreed(), privacy_agreed: privacyAgreed(), _hp: '' }),
    });
    data = await res.json();
  } catch {
    resetButton();
    banner('Network error. Your registration was not sent, so please try again.');
    return;
  }
  resetButton();

  if (!data.ok) {
    if (Array.isArray(data.errors)) {
      const unmapped = data.errors.filter((msg) => {
        const f = SCHEMA.fields.find((x) => msg.startsWith(x.label));
        return !(f && setFieldState(f.name, msg.slice(f.label.length).trim() || msg, v[f.name]));
      });
      banner('<strong>Please fix the following:</strong><ul>' +
        (unmapped.length ? unmapped : ['Check the highlighted questions below.'])
          .map((m) => `<li>${esc(m)}</li>`).join('') + '</ul>');
      focusFirstInvalid();
    } else {
      banner(esc(data.error || 'Something went wrong. Please try again.') +
        (data.uploadCleared ? ' Your file was removed, so please attach it again.' : ''));
      if (data.uploadCleared) resetUploads();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    return;
  }

  showDone(data, v);
}

function resetButton() {
  const btn = $('submit');
  btn.disabled = false;
  btn.classList.remove('loading');
  btn.querySelector('.btn-label').textContent = 'Complete registration';
}

function showDone(data, v) {
  $('form').hidden = true;
  $('progress-card').hidden = true;
  $('banner').hidden = true;
  $('done').hidden = false;
  $('ref').textContent = data.ref;

  const to = v[SCHEMA.fields.find((f) => f.type === 'email')?.name] || 'your email address';
  $('done-msg').textContent = (data.mailSent || data.mailQueued)
    ? `Your spot is confirmed. A confirmation email is on its way to ${to}.`
    : 'Your registration has been recorded.';

  const warn = $('mail-warn');
  if (!data.mailSent && !data.mailQueued) {
    warn.hidden = false;
    warn.innerHTML = '<strong>Your registration was saved</strong>, but the confirmation ' +
      'email could not be sent. Please contact the organisers.' +
      (data.detail ? `<br><small>${esc(data.detail)}</small>` : '');
  } else {
    warn.hidden = true;
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- Auto-advance Guide UI Feature ---
document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('form');
  if (!form) return;

  function advanceToNextField(currentElement) {
    if (currentElement.checkValidity && !currentElement.checkValidity()) return;
    const fields = Array.from(document.querySelectorAll('.field:not([hidden])'));
    const currentWrap = currentElement.closest('.field');
    if (!currentWrap) return;
    
    const currentIndex = fields.indexOf(currentWrap);
    if (currentIndex > -1 && currentIndex < fields.length - 1) {
      const nextField = fields[currentIndex + 1];
      nextField.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const input = nextField.querySelector('input:not([type=hidden]),select,textarea');
      if (input) input.focus({ preventScroll: true });
    }
  }

  form.addEventListener('change', (e) => {
    if (e.target.tagName === 'SELECT' || (e.target.tagName === 'INPUT' && (e.target.type === 'radio' || e.target.type === 'checkbox'))) {
      advanceToNextField(e.target);
    }
  });

  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && ['text', 'email', 'tel', 'number'].includes(e.target.type)) {
      e.preventDefault();
      advanceToNextField(e.target);
    }
  });
});
