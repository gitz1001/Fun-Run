/**
 * A cell that opens as text in Excel and Sheets.
 *
 * Everything is quoted, and a value a spreadsheet would evaluate is
 * prefixed with an apostrophe so it cannot run — a registration form is
 * user input and this file is opened by somebody in the finance office,
 * where "=" and "+cmd|..." are a real vector.
 *
 * A leading + or - on a plain phone number is not one of those, so it is
 * left alone rather than stamping an apostrophe through every +63 number.
 *
 * Kept in a file of its own, with no page behind it, so the tests can import
 * exactly what the dashboard runs.
 */
const PLAIN_NUMBER = /^[+-][0-9 ()\-.]*$/;

export function csvCell(value) {
  const v = String(value ?? '');
  const executable = /^[=@\t\r]/.test(v)
    || (/^[+-]/.test(v) && !PLAIN_NUMBER.test(v));
  const cell = executable ? "'" + v : v;
  return '"' + cell.replace(/"/g, '""') + '"';
}
