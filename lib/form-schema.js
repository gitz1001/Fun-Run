/**
 * The registration questions.
 *
 * This is the single source of truth for the whole app: the rendered page,
 * client and server validation, the Google Sheet columns, and the confirmation
 * email all derive from this list. Add or reorder a field here and everything
 * follows.
 *
 * Registrations are written to Postgres and mirrored into the Google Sheet via
 * the Sheets API — there is no Google Form in the path, so no entry ids.
 */

/**
 * The two cuts the race shirt is made in, and the supplier's measurements for
 * each — copied figure for figure off the Solido charts (Unisex_size.png and
 * Kidz_shirt_size.png), not interpolated from them.
 *
 * One answer still covers both. "Kids 14" and "5XS" are the same 28" chest in
 * different garments, so the size string alone tells the printer which cut to
 * cut, and the Sheet needs no second column to carry the fit. That is also why
 * the kids sizes are written out long: a bare "2XS" appears on both charts
 * against two different shirts, and an order form must not contain a size that
 * means two things.
 *
 * `half` is the measurement you actually take — one pass of the tape across
 * the flat garment — and `chest` is that doubled, which is the number people
 * know their own size by. Both are kept because the doubling is exactly where
 * orders go wrong: read the 20" as a chest and you order two sizes small.
 *
 * The kids chart carries no body-length column, so kids sizes carry no
 * `length`, and the chart shows a dash rather than a zero.
 */
export const SHIRT_FITS = [
  {
    id: 'unisex',
    label: 'Unisex',
    tagline: 'Adult & teen',
    note: 'The standard race shirt, in the full ladder from 5XS to 6XL.',
    // Charted after the size itself, in this order. A measurement no size
    // carries — a sleeve length, say — is an entry here plus a key on each
    // size below, and nothing else: the table builds itself from this list.
    columns: [
      { key: 'chest', label: 'Chest' },
      { key: 'length', label: 'Length' },
    ],
    sizes: [
      { value: '5XS', half: 14, chest: 28, length: 22.094 },
      { value: '4XS', half: 15, chest: 30, length: 23.094 },
      { value: '3XS', half: 16, chest: 32, length: 24.094 },
      { value: '2XS', half: 17, chest: 34, length: 25.094 },
      { value: 'XS',  half: 18, chest: 36, length: 26.094 },
      { value: 'S',   half: 19, chest: 38, length: 27.094 },
      { value: 'M',   half: 20, chest: 40, length: 28.094 },
      { value: 'L',   half: 21, chest: 42, length: 29.094 },
      { value: 'XL',  half: 22, chest: 44, length: 30.094 },
      { value: '2XL', half: 23, chest: 46, length: 31.094 },
      { value: '3XL', half: 24, chest: 48, length: 32.094 },
      { value: '4XL', half: 25, chest: 50, length: 33.094 },
      { value: '5XL', half: 26, chest: 52, length: 34.094 },
      { value: '6XL', half: 27, chest: 54, length: 35.094 },
    ],
  },
  {
    id: 'kids',
    label: 'Kids',
    tagline: 'Size 8 – 20',
    note: 'Cut for children. Where a letter size is given too, both names mean the same shirt.',
    columns: [
      { key: 'alias', label: 'Also called' },
      { key: 'chest', label: 'Chest' },
    ],
    sizes: [
      { value: 'Kids 8',  half: 11, chest: 22 },
      { value: 'Kids 10', half: 12, chest: 24 },
      { value: 'Kids 12', half: 13, chest: 26 },
      { value: 'Kids 14', half: 14, chest: 28, alias: '5XS' },
      { value: 'Kids 16', half: 15, chest: 30, alias: '4XS' },
      { value: 'Kids 18', half: 16, chest: 32, alias: '3XS' },
      { value: 'Kids 20', half: 17, chest: 34, alias: '2XS' },
    ],
  },
];

/**
 * The measuring instructions off the foot of both charts, keyed by the
 * measurement they explain so the guide can show only the ones the fit on
 * screen actually charts — the kids shirt has no body length to explain.
 */
export const SHIRT_MEASURE = {
  chest: {
    label: 'Chest',
    text: 'Lay the shirt flat. Measure straight across, 1" below the armhole, then multiply by two.',
  },
  length: {
    label: 'Body length',
    text: 'Lay the shirt flat. Measure from the seam at the base of the neck down to the bottom hem.',
  },
  note: 'Smooth the shirt out without stretching it. All measurements are approximate, in inches.',
};

export const FORM = {
  title: 'Southville Run For A Cause 2026',
  description:
    'A community fun run by Southville for Others (SFO) and the Alumni Department. A confirmation email with your reference number is sent only after your registration has been recorded.',

  // Which field holds the runner's address (used as the mail recipient).
  emailField: 'email_address',
  // Which field to greet them by.
  nameField: 'full_name',
  // Which answer separates SISC employees paying by payroll deduction from
  // everybody else. The staff dashboard splits its figures on this.
  employeeField: 'payment_method',
  employeeValue: 'Employee',

  fields: [
    {
      name: 'full_name',
      section: "Runner details",
      label: 'Full name',
      type: 'short',
      required: true,
      maxLength: 120,
      help: 'As it should appear on your Certificate.',
    },
    {
      name: 'email_address',
      section: "Runner details",
      label: 'Email address',
      type: 'email',
      required: true,
      help: 'Your confirmation and race details will be sent here.',
    },
    {
      name: 'contact_number',
      section: "Runner details",
      label: 'Contact number',
      type: 'short',
      required: true,
      pattern: '^[0-9 +().-]{7,20}$',
      patternMessage: 'That contact number does not look valid.',
    },
    {
      name: 'age',
      section: "Runner details",
      label: 'Age',
      type: 'short',
      required: true,
      pattern: '^[0-9]{1,3}$',
      patternMessage: 'Enter your age in years.',
    },
    {
      name: 'sex',
      section: "Runner details",
      label: 'Sex',
      type: 'choice',
      required: true,
      options: ['Male', 'Female', 'Prefer not to say'],
    },
    {
      name: 'school_affiliation',
      section: "Runner details",
      label: 'School / Affiliation',
      type: 'choice',
      required: true,
      options: [
        'SISC College',
        'SISC K12 and IB',
        'SISFU',
        'SISC Employee',
        'SMC',
        'SSIS B',
        'SSIS M',
        'ASAT',
        'Alumni',
        'Others',
      ],
      help: 'Select the school or Southville affiliation you came from.',
    },
    {
      name: 'race_category',
      section: "Race details",
      label: 'Race category',
      type: 'choice',
      required: true,
      options: ['1K', '3K', "5K", '10K'],
    },
    {
      name: 'shirt_size',
      section: "Race details",
      label: 'Shirt size',
      type: 'choice',
      required: true,
      help: 'Kids and unisex are cut differently. Pick the fit, then read across the chart.',

      // Both derived from SHIRT_FITS rather than written out again, so the
      // sizes on offer and the sizes charted are the same list by
      // construction: add a row up there and it turns up in the menu, in the
      // chart, and in what the server will accept, all at once.
      options: SHIRT_FITS.flatMap((f) => f.sizes.map((s) => s.value)),
      // Twenty-one sizes in one flat menu is a scroll with no landmarks. The
      // menu is cut into its two cuts, which is the same division the chart
      // on the page is showing.
      optionGroups: SHIRT_FITS.map((f) => ({
        label: `${f.label} · ${f.tagline}`,
        options: f.sizes.map((s) => s.value),
      })),

      // Sizes this question used to offer, still accepted but no longer
      // shown. A tab opened before this deploy is holding the old menu and
      // will post one of these; turning that runner away at the last step to
      // tell them their size no longer exists would be the worst possible
      // moment to be right. Only "#14/#16/#18" are gone — the letter sizes
      // are all still on the unisex chart above.
      legacyOptions: ['#14', '#16', '#18'],

      // What the size guide on the registration page draws. Nothing on the
      // server reads it; it travels with the options it describes.
      sizeChart: { units: 'inches', fits: SHIRT_FITS, measure: SHIRT_MEASURE },
    },
    {
      name: 'team_or_organization',
      section: "Race details",
      label: 'Team / Organization',
      type: 'short',
      required: false,
      help: 'Leave blank if running as an individual.',
    },
    {
      name: 'payment_method',
      section: 'Payment',
      label: 'Payment method',
      type: 'choice',
      required: true,
      options: ['Bank transfer', 'Employee'],
      help: 'SGEN employees may choose "Employee" to settle the fee through salary deduction.',
    },

    // --- SISC salary deduction ---------------------------------------
    // These four live in a pop-up rather than the main flow: they are asked
    // only of employees, and only once "Employee" is the chosen method.
    // "panel" tells the page where to render them; "showIf" decides whether
    // they are asked at all, on both the page and the server.
    {
      name: 'sd_full_name',
      section: 'Payment',
      panel: 'salary-deduction',
      showIf: { field: 'payment_method', equals: 'Employee' },
      label: 'Employee full name',
      type: 'short',
      required: true,
      maxLength: 120,
      placeholder: 'Juan Dela Cruz',
    },
    {
      name: 'sd_employee_number',
      section: 'Payment',
      panel: 'salary-deduction',
      showIf: { field: 'payment_method', equals: 'Employee' },
      label: 'Employee number',
      type: 'short',
      required: true,
      maxLength: 40,
      placeholder: 'e.g. 2019-0431',
    },
    {
      name: 'sd_department',
      section: 'Payment',
      panel: 'salary-deduction',
      showIf: { field: 'payment_method', equals: 'Employee' },
      label: 'Department / Office',
      type: 'short',
      required: true,
      maxLength: 120,
      placeholder: 'e.g. Alumni Department',
    },
    {
      name: 'sd_authorization',
      section: 'Payment',
      panel: 'salary-deduction',
      showIf: { field: 'payment_method', equals: 'Employee' },
      label: 'Salary deduction authorization',
      type: 'short',
      required: true,
      maxLength: 120,
      placeholder: 'DELA CRUZ, JUAN',
      help: 'By placing your name, you agree that the deduction as such will be made from your payroll. Please type your LAST NAME, FIRST NAME.',
      pattern: '^[^,]{2,},[^,]{2,}$',
      patternMessage: 'Type it as LAST NAME, FIRST NAME, with a comma between them.',
    },

    {
      name: 'proof_of_payment',
      section: 'Payment',
      label: 'Proof of payment',
      // Uploaded to Vercel Blob; the resulting link is what reaches the Sheet.
      type: 'file',
      required: true,
      // There is no receipt to show for a payroll deduction — the authorisation
      // in the panel above is the record — so the question is not asked at all.
      showIf: { field: 'payment_method', notEquals: 'Employee' },
      help: 'Photo or PDF of your deposit slip or bank transfer receipt. Max 4 MB.',
    },
    {
      name: 'emergency_contact_name',
      section: "Emergency & medical",
      label: 'Emergency contact name',
      type: 'short',
      required: true,
    },
    {
      name: 'emergency_contact_number',
      section: "Emergency & medical",
      label: 'Emergency contact number',
      type: 'short',
      required: true,
      pattern: '^[0-9 +().-]{7,20}$',
      patternMessage: 'That emergency contact number does not look valid.',
    },
    {
      name: 'medical_conditions',
      section: "Emergency & medical",
      label: 'Medical conditions or allergies',
      type: 'paragraph',
      required: false,
      help: 'Tell us anything our medical team should know. Write "None" if not applicable.',
    },
  ],
};


/**
 * The waiver box on the intro page.
 *
 * Deliberately not one of `fields`: it is ticked before the registration form
 * is even on screen, so it is not a question the form draws. Everything
 * downstream still treats it like an answer — the database, the sheet, the
 * confirmation email and the dashboard all record it — because it is the only
 * proof that the runner accepted the waiver.
 */
export const AGREEMENT = {
  name: 'waiver_agreed',
  label: 'Waiver of Liability',
  agreed: 'Agreed',
};

export const PRIVACY = {
  name: 'privacy_agreed',
  label: 'Data Privacy Consent',
  agreed: 'Agreed',
};

export function privacyState(body) {
  const v = body?.[PRIVACY.name];
  if (v === undefined || v === null || v === '') return null;
  return v === true || v === 'true' || v === 'on' || v === '1' || v === PRIVACY.agreed;
}

export function agreedToPrivacy(body) {
  return privacyState(body) === true;
}

/**
 * What this submission says about the waiver: true, false, or null for a
 * submission that does not mention it at all.
 *
 * The three states matter. A tab opened before the waiver shipped sends
 * nothing — that is an old page, not a runner who refused, and the two must
 * not be recorded or treated alike.
 *
 * The page sends a boolean, but a hand-rolled POST could send the string a
 * checkbox would normally carry, so both are read.
 */
export function waiverState(body) {
  const v = body?.[AGREEMENT.name];
  if (v === undefined || v === null || v === '') return null;
  return v === true || v === 'true' || v === 'on' || v === '1' || v === AGREEMENT.agreed;
}

/** Did this submission accept the waiver outright? */
export function agreedToWaiver(body) {
  return waiverState(body) === true;
}

/**
 * Is this question actually being asked, given the answers so far?
 *
 * A field with no `showIf` is always asked. One with `showIf` is asked only
 * while the field it depends on holds the matching answer — which is how the
 * salary-deduction questions stay out of the way of everybody who is paying
 * by GCash or bank transfer. The page and the server share this rule so they
 * can never disagree about what is required.
 */
export function isActive(field, answers) {
  const cond = field.showIf;
  if (!cond) return true;
  const raw = answers?.[cond.field];
  const current = typeof raw === 'string' ? raw.trim() : '';
  if (cond.equals !== undefined) return current === cond.equals;
  if (cond.notEquals !== undefined) return current !== cond.notEquals;
  return current !== '';
}

/**
 * The question whose answer marks a registration as an employee's, and the
 * answer that does it. Returns null if the schema no longer has one.
 */
export function employeeQuestion() {
  const f = FORM.fields.find((x) => x.name === FORM.employeeField);
  return f ? { label: f.label, value: FORM.employeeValue } : null;
}

/** The questions that apply to this particular set of answers. */
export function activeFields(answers) {
  return FORM.fields.filter((f) => isActive(f, answers));
}

/**
 * Every answer a choice question will still accept, which is not the same as
 * the answers it offers: a question whose options have been rewritten keeps
 * accepting the old ones through `legacyOptions`, so a page loaded before the
 * change can still be submitted. The error message names only the current
 * options — a retired size is accepted, never recommended.
 */
export function acceptedOptions(f) {
  return f.legacyOptions?.length ? [...f.options, ...f.legacyOptions] : f.options;
}

/** Server-side validation. Returns an array of human-readable errors. */
export function validate(body) {
  const errors = [];
  for (const f of FORM.fields) {
    // A question that is not being asked is neither required nor checked.
    if (!isActive(f, body)) continue;
    const raw = body[f.name];
    const value = typeof raw === 'string' ? raw.trim() : '';

    if (f.required && value === '') { errors.push(`${f.label} is required.`); continue; }
    if (value === '') continue;

    if (f.maxLength && value.length > f.maxLength) errors.push(`${f.label} is too long.`);
    if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      errors.push(`${f.label} does not look like a valid email address.`);
    }
    if (f.pattern && !new RegExp(f.pattern).test(value)) {
      errors.push(f.patternMessage || `${f.label} is not in the expected format.`);
    }
    if (f.type === 'file' && !/^https:\/\/\S+$/.test(value)) {
      errors.push(`${f.label} must be uploaded before submitting.`);
    }
    if (f.type === 'choice' && f.options?.length && !acceptedOptions(f).includes(value)) {
      errors.push(`${f.label} must be one of: ${f.options.join(', ')}.`);
    }
  }

  // Both confirmations are mandatory. The browser gate handles normal use,
  // while this server-side check prevents a direct POST from bypassing either
  // checkbox.
  if (waiverState(body) !== true) {
    errors.push(`${AGREEMENT.label} must be accepted before you can register.`);
  }

  // Privacy consent is a required gate for the current registration flow.
  // Keep the check server-side as well so a direct POST cannot bypass the
  // main-page checkbox.
  if (privacyState(body) !== true) {
    errors.push(`${PRIVACY.label} must be confirmed before you can register.`);
  }

  return errors;
}
