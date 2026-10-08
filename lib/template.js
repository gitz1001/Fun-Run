import { SISC_CREST } from './email-assets.js';
import { FORM } from './form-schema.js';

/**
 * The letterhead every confirmation carries.
 *
 * Kept here as data rather than buried in the markup so the address and the
 * numbers are changed in one obvious place.
 */
export const SCHOOL = {
  name: 'Southville International School and Colleges',
  address: "1281 Tropical Ave. Cor. Luxembourg St., BF Homes Int'l., Las Piñas City, Metro Manila, Philippines",
  tel: 'Tel. Nos. 8825-6374 (PR Office) / 8820-8702',
  mobile: 'Mobile No. +63 917 853 2450',
  fax: 'Fax No. (632) 829-1675',
};

// Header palette. Navy deep enough for white text to clear AA contrast.
const NAVY = '#B058B0';
const NAVY_BAR = '#B058B0';
const NAVY_INK = '#c3d3ef';

/**
 * The letterhead block: crest on the left, school and contact details beside
 * it, on the dark blue ground.
 *
 * Laid out with tables and inline styles because that is the only thing every
 * mail client agrees on — Outlook renders through Word, which has no flexbox
 * and no float. The crest is dark artwork, so it sits on a white tile rather
 * than directly on the navy, and it is a cid: attachment rather than a hosted
 * URL so it appears without the recipient having to allow remote images.
 */
const letterhead = () => `
   <tr><td style="background:${NAVY};padding:22px 24px">
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
       <td width="${SISC_CREST.width}" valign="top" style="width:${SISC_CREST.width}px;padding-right:16px">
         <table role="presentation" cellpadding="0" cellspacing="0" border="0"
                style="background:#ffffff;border-radius:6px">
          <tr><td style="padding:5px">
            <img src="cid:${SISC_CREST.cid}" width="${SISC_CREST.width}" height="${SISC_CREST.height}"
                 alt="${esc(SCHOOL.name)}"
                 style="display:block;width:${SISC_CREST.width}px;height:${SISC_CREST.height}px;border:0;outline:none;text-decoration:none">
          </td></tr>
         </table>
       </td>
       <td valign="top" style="color:#ffffff;font-family:Arial,Helvetica,sans-serif">
         <div style="font-size:16px;font-weight:bold;line-height:1.3;color:#ffffff">${esc(SCHOOL.name)}</div>
         <div style="font-size:11px;line-height:1.6;color:${NAVY_INK};margin-top:6px">
           ${esc(SCHOOL.address)}<br>
           ${esc(SCHOOL.tel)}&nbsp; |&nbsp; ${esc(SCHOOL.mobile)}<br>
           ${esc(SCHOOL.fax)}
         </div>
       </td>
      </tr>
     </table>
   </td></tr>`;

// The stored proof of payment is a staff-only link, which is no use to the
// runner reading this — they would be asked for a passcode. The email says
// the receipt arrived instead. Nothing else is ever turned into a link: every
// other answer is the runner's own text, shown back to them as text.
const FILE_LABELS = new Set(FORM.fields.filter((f) => f.type === 'file').map((f) => f.label));
const RECEIVED = 'Received';

const shown = ([label, value]) => [label, FILE_LABELS.has(label) ? RECEIVED : value];

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function confirmationHtml({ answers, appName, ref, when }) {
  const rows = answers
    .filter(([, v]) => v !== '' && v != null)
    .map(shown)
    .map(
      ([label, value]) => `<tr>
        <td style="padding:10px 14px;border-bottom:1px solid #e8eaed;color:#5f6368;font-size:13px;white-space:nowrap">${esc(label)}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #e8eaed;color:#202124;font-size:14px;font-weight:500">${esc(value)}</td>
      </tr>`)
    .join('');

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:24px;background:#f1f3f4;font-family:Arial,Helvetica,sans-serif">
 <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0"
         style="background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(60,64,67,.2)">
   ${letterhead()}
   <tr><td style="background:${NAVY_BAR};padding:16px 24px;color:#ffffff">
     <div style="font-size:19px;font-weight:bold">Registration confirmed</div>
     <div style="font-size:13px;color:${NAVY_INK};margin-top:4px">${esc(appName)}</div>
   </td></tr>
   <tr><td style="padding:26px 28px 8px;color:#202124;font-size:15px;line-height:1.6">
     Thank you for registering. We have received your details and recorded them.
     Here is a copy for your records:
   </td></tr>
   <tr><td style="padding:8px 28px 4px">
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
            style="border:1px solid #e8eaed;border-radius:8px;border-collapse:separate">
       ${rows}
       <tr>
         <td style="padding:10px 14px;color:#5f6368;font-size:13px">Reference</td>
         <td style="padding:10px 14px;color:#202124;font-size:14px;font-weight:600">${esc(ref)}</td>
       </tr>
     </table>
   </td></tr>
   <tr><td style="padding:18px 28px 28px;color:#5f6368;font-size:12px;line-height:1.6">
     Submitted ${esc(when)}. If you did not make this registration you can ignore this email.
     <br>This is an automated message — please do not reply.
   </td></tr>
  </table>
 </td></tr></table>
</body></html>`;
}

export function confirmationText({ answers, appName, ref, when }) {
  const lines = answers
    .filter(([, v]) => v !== '' && v != null)
    .map(shown)
    .map(([l, v]) => `  ${l}: ${v}`)
    .join('\n');
  return `${SCHOOL.name}
${SCHOOL.address}
${SCHOOL.tel}  |  ${SCHOOL.mobile}
${SCHOOL.fax}

------------------------------------------------------------

REGISTRATION CONFIRMED — ${appName}

Thank you for registering. Your details:

${lines}
  Reference: ${ref}

Submitted ${when}
This is an automated message.
`;
}
