# Southville Run For A Cause — registration

A public fun run registration page with a staff dashboard, deployed on
**Vercel**. A registration is written to **Postgres** (Neon), mirrored into a
**Google Sheet**, and confirmed by email over **Gmail SMTP (XOAUTH2)**.
Proof-of-payment receipts are stored in a private **Google Drive** folder.

```
Visitor -> public/index.html  (questions rendered from lib/form-schema.js)
              |
              |-- receipt -> POST /api/drive-upload -> Google Drive
              |                 the file id is noted in the `uploads` table
              v
        POST /api/register
              |
              |-- 1. the receipt id must be in `uploads`, and unused
              |-- 2. INSERT into Postgres      <- this decides "registered"
              |      if it fails -> 502, nothing is emailed, nothing is deleted
              |-- 3. respond to the runner with their reference
              '-- 4. after the response: append to the Sheet, send the email
                     (either failing is recorded on the row and replayable)

Staff   -> /staff -> /api/staff-login, /api/staff-data, /api/receipt
```

Postgres is the source of truth. The Sheet is a mirror and the email is a
courtesy, so an outage in either never loses a registration.

---

## Setup

### 1. Google Cloud OAuth client
1. **APIs & Services → Library →** enable **Gmail API**, **Google Sheets API**
   and **Google Drive API**.
2. **OAuth consent screen → User type: Internal.**
   Left on *Testing*, Google expires the refresh token after **7 days**.
3. **Credentials → Create OAuth client ID → Web application.**
   Authorised redirect URI: `http://localhost:5555/oauth2callback`
4. Copy the Client ID **and** the Client secret from that *same* client.
   A mismatched pair is the `invalid_client` error.

### 2. Environment
```bash
cp .env.example .env.local
```
Fill it in, then get a refresh token (written into `.env.local` for you):
```bash
npm run token
```

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres — Vercel → Storage → Neon. `POSTGRES_URL` also works |
| `GMAIL_USER` | the sending mailbox |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from the **same** OAuth client |
| `GOOGLE_REFRESH_TOKEN` | from `npm run token`; covers Gmail, Sheets and Drive |
| `GOOGLE_DRIVE_FOLDER_ID` | the private folder receipts are uploaded to |
| `SHEET_ID` / `SHEET_TAB` | the mirror spreadsheet and tab (default `Registrations`) |
| `STAFF_PASSWORD` | the shared staff passcode; turns the dashboard on |
| `STAFF_SECRET` | optional: signs the staff session cookie. Derived from the passcode if unset |
| `SITE_URL` | the public origin, used to build receipt links |
| `MAIL_FROM_NAME`, `ADMIN_COPY`, `APP_NAME` | optional |

`SMTP_PASSWORD` (a Gmail App Password) is an alternative to OAuth for mail
only; Sheets and Drive still need the three `GOOGLE_*` values.

Generate `STAFF_SECRET` with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Changing `STAFF_SECRET` signs every staff member out, which is how a leaked
passcode or a departed volunteer is handled.

### 3. Database and Sheet
```bash
npm run db:init       # creates / upgrades the tables; safe to repeat
npm run sheet:init    # creates the tab and writes the header row
npm run doctor        # checks every moving part and says what is missing
```
The app also brings an older database up to date by itself on first use, so a
deploy that adds a table does not depend on someone remembering `db:init`.

### 4. Run and deploy
```bash
npm run dev           # http://localhost:3000, with the same headers as production
npm test              # node's built-in test runner; no network, no database
npx vercel --prod
```
`DEV_HOT=1 npm run dev` hot-reloads `api/*.js`. `npm run push-env -- --yes`
copies `.env.local` to Vercel's Production environment.

---

## Files

| Path | Purpose |
|---|---|
| `lib/form-schema.js` | the questions and their validation — **the single source of truth** |
| `lib/db.js` | Postgres schema and queries: `registrations`, `uploads`, `rate_limits` |
| `lib/receipts.js` | what counts as a receipt id, and the link stored for one |
| `lib/google-drive.js` `lib/google-auth.js` | Drive upload / fetch / delete over the OAuth token |
| `lib/sheets.js` | appends the mirror row; adds new columns to the right, never reorders |
| `lib/mailer.js` `lib/template.js` | Nodemailer over Gmail, and the confirmation email |
| `lib/staff-auth.js` | the staff passcode, signed session cookie and login throttle |
| `lib/rate-limit.js` | per-IP limits counted in Postgres, so they hold across instances |
| `api/register.js` | validate → check receipt → record → respond → mirror and email |
| `api/drive-upload.js` | receives a receipt (WebP, JPEG, PNG, HEIC or PDF, ≤ 4 MB) and stores it |
| `api/receipt.js` | serves a receipt to signed-in staff |
| `api/schema.js` | serves the questions to the page |
| `api/staff-*.js` | sign-in, dashboard data, health check, reset |
| `public/` | the registration page, the staff dashboard, and their assets |
| `tools/` | `doctor`, `db-init`, `sheet-init`, `replay`, `sweep-uploads`, `get-refresh-token`, `push-env`, `dev-server` |
| `test/` | the rules that must not regress |
| `assets-src/` | working files and supplier artwork; never deployed |

`tools/fetch-form-schema.js`, `tools/import-form-source.js` and
`lib/parse-form.js` date from when the questions were cloned from a Google
Form. They regenerate a bare `lib/form-schema.js` and would overwrite the
hand-maintained one, so do not run them against this repo.

---

## Receipts

Photos are resized in the browser to a 1400px edge and re-encoded (stepping
down in quality towards ~700 KB), which also strips camera metadata. The
format is WebP where the browser can encode it and **JPEG where it cannot —
Safari, and so every browser on an iPhone, cannot.** PDFs are sent as they
are, and so is a photo the browser could not re-encode. The file picker does
not list HEIC on purpose: an iPhone then converts a HEIC photo to JPEG itself.
The server checks the file's signature against its declared type.

The rules that keep this safe:

* The browser submits only the **Drive file id**. `api/register.js` accepts it
  only if `api/drive-upload.js` recorded it in the `uploads` table and no other
  registration has used it. The link that is stored is built by the server.
* **No web request deletes from Drive.** A registration that fails to save
  frees its receipt so the runner can simply submit again.
* `/api/receipt` serves only ids in `uploads`, to signed-in staff.
* Uploads that never became a registration are listed by `npm run sweep` and
  deleted with `npm run sweep -- --fix` once they are a day old. That command
  deletes only ids from `uploads` and never one a registration refers to.

The confirmation email is a copy of the runner's own answers. The receipt is
shown there as "Received", since the stored link is for staff.

---

## Payment methods

Two options, set in `lib/form-schema.js` under `payment_method`:

| Option | What happens |
|---|---|
| Bank transfer | bank details are shown in the Payment section; a receipt must be uploaded |
| Employee | opens the **Salary Deduction** pop-up — employee name, number, department and a typed payroll authorisation — and no receipt is asked for |

The salary-deduction questions are ordinary schema fields with two extra keys:

```js
panel: 'salary-deduction',                                // drawn in the pop-up
showIf: { field: 'payment_method', equals: 'Employee' },  // only asked of employees
```

`isActive()` in `lib/form-schema.js` is the single rule for whether a
conditional question applies, and both the page and `validate()` use it.
`api/register.js` blanks any answer to a question that was not asked.

### After changing the questions

`headerRow()` in `lib/sheets.js` derives the Sheet columns from the schema. A
new question is appended as a new column on the right of an existing sheet;
existing columns are never moved, so old rows stay aligned.

---

## Staff dashboard

`/staff` splits registrations into **Employees** (salary deduction) and
**Non-employees**, because payroll chases one and a receipt settles the other.
`FORM.employeeField` / `FORM.employeeValue` define what counts as an employee.

* **Search** matches reference, name, email or any answer.
* **The figures at the top** (race category, school) filter the table to
  exactly that answer when pressed, and lift the filter when pressed again.
* **A registration's detail** shows every answer, the waiver and the privacy
  consent with the time each was given, and an "Open receipt" link.
* **Export CSV** exports the whole tab you are on. The file is UTF-8 with a
  BOM, every cell is quoted, and a value a spreadsheet would execute is
  prefixed with an apostrophe — a `+63` phone number is left alone.
* **Reset** deletes every registration after downloading a CSV backup and a
  typed confirmation. It does not touch the Google Sheet or the receipts in
  Drive.

`npm run replay` lists registrations whose Sheet row or email did not go out,
and `npm run replay -- --fix` sends them.

---

## Design notes

- **No registration, no email**, and **a mail failure never loses a
  registration**: the response is `200 ok:true` once the row is saved.
- Every answer is stripped of control characters and length-capped before it
  is validated or stored.
- Per-IP limits (registrations, uploads, failed sign-ins) are counted in
  Postgres and fall back to memory if the database is unreachable.
- Staff sessions are a signed, HttpOnly, SameSite=Strict cookie valid for 12
  hours.
- All user input is escaped in the page, the dashboard and the email, and no
  answer is ever rendered as a link.
- `vercel.json` sets a strict Content-Security-Policy (`script-src 'self'`),
  so scripts live in files, not inline.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Staff page says "not enabled" | `STAFF_PASSWORD` is missing in that environment |
| Page says "Preview mode" | no `DATABASE_URL` in that environment |
| Uploads fail with "not set up yet" | Drive OAuth, `GOOGLE_DRIVE_FOLDER_ID` or the database is missing |
| "must be uploaded before submitting" on a file that was attached | the upload is unknown or already used — attach it again |
| `invalid_client` | client id and secret are from different OAuth clients |
| `invalid_grant` | refresh token expired — set the consent screen to *Internal*, re-run `npm run token` |
| `535-5.7.8` | Workspace admin has SMTP/IMAP access disabled for that user |
| Sheet 403 | the account behind the refresh token cannot edit the spreadsheet |
| A variable was added but nothing changed | Vercel reads variables at deploy time — redeploy |
