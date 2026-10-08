import { requireStaff } from '../lib/staff-auth.js';
import { sql, dbConfigured, ensureSchema } from '../lib/db.js';
import { FORM, employeeQuestion, AGREEMENT, PRIVACY } from '../lib/form-schema.js';
import { normaliseReference } from '../lib/reference.js';

/**
 * Registrations for the staff dashboard.
 *
 *   GET /api/staff-data                  -> newest 50, plus totals
 *   GET /api/staff-data?q=SFO-4K7M2X     -> exact reference lookup
 *   GET /api/staff-data?q=juan           -> name / email / contact search
 *   GET /api/staff-data?type=employee    -> SISC employees on salary deduction
 *   GET /api/staff-data?type=public      -> everybody else
 *   GET /api/staff-data?field=Race+category&value=5K   -> one answer, exactly
 *   GET /api/staff-data?limit=200&offset=50
 *
 * Every response is behind requireStaff, because these rows contain contact
 * numbers, emergency contacts and medical notes.
 */

const MAX_LIMIT = 200;

export default async function handler(req, res) {
  // Set before the guard: the 401 that turns a stranger away is a response
  // like any other, and must not sit in a shared cache either.
  res.setHeader('Cache-Control', 'no-store, private');

  if (!requireStaff(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'GET only' });
  }
  if (!dbConfigured()) {
    return res.status(503).json({ ok: false, error: 'No database configured.' });
  }

  // Never let a dashboard page be cached by a shared proxy.

  const q = String(req.query?.q ?? '').trim();
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query?.limit) || 50));
  const offset = Math.max(0, Number(req.query?.offset) || 0);

  // Employees paying by salary deduction are chased up by payroll, not by a
  // receipt, so staff work the two groups separately. One flag drives the
  // filter in every branch below: "all" ignores it, otherwise a row is kept
  // only when its employee-ness matches what was asked for.
  const employee = employeeQuestion();
  const type = ['employee', 'public'].includes(String(req.query?.type ?? ''))
    ? String(req.query.type)
    : 'all';
  const allTypes = type === 'all' || !employee;
  const wantEmployee = type === 'employee';
  const empLabel = employee?.label ?? '';
  const empValue = employee?.value ?? '';

  // The figures at the top of the dashboard filter the table when clicked.
  // That is a match on one question's answer, not a search: "Alumni" as a
  // school must not also find everyone in the Alumni Department. Only a
  // question the form actually has can be named.
  const fieldLabel = String(req.query?.field ?? '');
  const fieldValue = String(req.query?.value ?? '');
  const anyField = !FORM.fields.some((f) => f.label === fieldLabel);

  try {
    await ensureSchema();
    const db = sql();
    let rows;
    let matchedReference = null;

    if (q) {
      // A tidy reference wins outright — that is the race-day path.
      const ref = normaliseReference(q);
      if (ref) {
        matchedReference = ref;
        rows = await db`
          SELECT reference, created_at, full_name, email, proof_url,
                 answers, waiver_agreed, waiver_agreed_at,
                 privacy_agreed, privacy_agreed_at,
                 sheet_synced, sheet_error, email_sent, email_error
            FROM registrations
           WHERE reference = ${ref}
             AND (${allTypes}::boolean
                  OR COALESCE(answers ->> ${empLabel} = ${empValue}, FALSE) = ${wantEmployee}::boolean)
             AND (${anyField}::boolean OR COALESCE(answers ->> ${fieldLabel}, '') = ${fieldValue})`;
      }
      if (!rows || rows.length === 0) {
        const like = `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`;
        rows = await db`
          SELECT reference, created_at, full_name, email, proof_url,
                 answers, waiver_agreed, waiver_agreed_at,
                 privacy_agreed, privacy_agreed_at,
                 sheet_synced, sheet_error, email_sent, email_error
            FROM registrations
           WHERE (reference ILIKE ${like}
               OR full_name ILIKE ${like}
               OR email     ILIKE ${like}
               OR answers::text ILIKE ${like})
             AND (${allTypes}::boolean
                  OR COALESCE(answers ->> ${empLabel} = ${empValue}, FALSE) = ${wantEmployee}::boolean)
             AND (${anyField}::boolean OR COALESCE(answers ->> ${fieldLabel}, '') = ${fieldValue})
           ORDER BY created_at DESC
           LIMIT ${limit} OFFSET ${offset}`;
        matchedReference = null;
      }
    } else {
      rows = await db`
        SELECT reference, created_at, full_name, email, proof_url,
               answers, waiver_agreed, waiver_agreed_at,
               privacy_agreed, privacy_agreed_at,
               sheet_synced, sheet_error, email_sent, email_error
          FROM registrations
         WHERE (${allTypes}::boolean
                OR COALESCE(answers ->> ${empLabel} = ${empValue}, FALSE) = ${wantEmployee}::boolean)
             AND (${anyField}::boolean OR COALESCE(answers ->> ${fieldLabel}, '') = ${fieldValue})
         ORDER BY created_at DESC
         LIMIT ${limit} OFFSET ${offset}`;
    }

    const [{ total }] = await db`SELECT count(*)::int AS total FROM registrations`;

    // The split is counted over the whole table, not the page being shown, so
    // the figures stay meaningful while a search is narrowing the rows.
    let segments = null;
    if (employee) {
      const [row] = await db`
        SELECT count(*) FILTER (WHERE answers ->> ${empLabel} = ${empValue})::int AS employee,
               count(*) FILTER (WHERE answers ->> ${empLabel} IS DISTINCT FROM ${empValue})::int AS public
          FROM registrations`;
      segments = { employee: row.employee, public: row.public };
    }

    // Per-category and per-shirt-size counts, so staff can see the split
    // without exporting anything.
    const categoryField = FORM.fields.find((f) => /race|category|distance/i.test(f.label));
    const shirtField = FORM.fields.find((f) => /shirt|size/i.test(f.label));
    const schoolField = FORM.fields.find((f) => /school|affiliation/i.test(f.label));
    const breakdown = {};
    // Only needed where the figures are drawn. The export pages through
    // hundreds of rows and has no use for six extra queries on every page.
    const wanted = req.query?.stats === '0' ? [] : [['category', categoryField], ['shirt', shirtField], ['school', schoolField]];
    for (const [key, field] of wanted) {
      if (!field) { breakdown[key] = null; continue; }
      const counts = await db`
        SELECT answers ->> ${field.label} AS value, count(*)::int AS n
          FROM registrations
         WHERE answers ->> ${field.label} IS NOT NULL
         GROUP BY 1 ORDER BY 2 DESC`;
      breakdown[key] = { label: field.label, counts };
    }

    const problems = await db`
      SELECT count(*)::int AS n FROM registrations
       WHERE sheet_synced = FALSE OR email_sent = FALSE`;

    return res.status(200).json({
      ok: true,
      total,
      returned: rows.length,
      matchedReference,
      needsAttention: problems[0].n,
      type,
      employee,
      segments,
      // The waiver is not a question in the form, but the detail view lists
      // it with the answers, so it travels with them.
      fields: FORM.fields.map((f) => ({ label: f.label, type: f.type })),
      agreement: AGREEMENT,
      privacy: PRIVACY,
      filter: anyField ? null : { field: fieldLabel, value: fieldValue },
      breakdown,
      rows,
    });
  } catch (err) {
    console.error('[staff-data] query failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Could not read registrations.' });
  }
}
