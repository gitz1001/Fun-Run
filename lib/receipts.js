/**
 * Proof-of-payment receipts, as the rest of the app refers to them.
 *
 * A receipt is a Google Drive file this app uploaded. The browser hands back
 * only its file id; nothing it sends is ever used as a link or as something to
 * delete. Whether an id is real is decided by the `uploads` table in lib/db.js,
 * not by its shape — the patterns here only pull an id out of the spellings a
 * page might send.
 */

const ID = '[A-Za-z0-9_-]{10,200}';
const BARE = new RegExp(`^${ID}$`);
// What a page loaded before this deploy still posts, and what older rows hold.
const DRIVE_LINK = new RegExp(`^https://drive\\.google\\.com/file/d/(${ID})(?:[/?#]|$)`);
const PROXY_LINK = new RegExp(`^(?:https?://[^/\\s]+)?/api/receipt\\?id=(${ID})$`);

/** The Drive file id in a submitted value, or '' if it does not hold one. */
export function receiptFileId(value) {
  const raw = String(value ?? '').trim();
  if (BARE.test(raw)) return raw;
  return raw.match(DRIVE_LINK)?.[1] || raw.match(PROXY_LINK)?.[1] || '';
}

/**
 * The link stored with a registration — in the database, the Sheet and the
 * dashboard. It is the same Google Drive link the site has always stored, so
 * rows written before and after this change read alike and staff open a
 * receipt the way they already do. What changed is who writes it: the server
 * builds it from a file id it has checked, instead of storing whatever link
 * the browser sent.
 */
export function receiptLink(fileId) {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view?usp=sharing`;
}

/** Links the dashboard may render as "Open receipt": ours, or an older Drive one. */
export function isReceiptLink(value) {
  const raw = String(value ?? '').trim();
  return DRIVE_LINK.test(raw) || PROXY_LINK.test(raw);
}
