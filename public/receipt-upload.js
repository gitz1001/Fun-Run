/**
 * Getting a receipt from the runner's device into Google Drive — shared by
 * the registration form (app.js) and the chat assistant (chat.js), so the two
 * can never disagree about what fits.
 *
 *   photo  -> shrunk here first (WebP, or JPEG on an iPhone), usually < 1 MB
 *   ≤ 4 MB -> POST /api/drive-upload, which stores it            (one step)
 *   > 4 MB -> /api/upload-session opens a one-file Drive session, the bytes
 *             go straight to Google, and the server checks the result
 *
 * The two routes exist because Vercel refuses a function request body over
 * 4.5 MB, whatever the code says. Keep MAX_UPLOAD and PROXY_MAX in step with
 * lib/uploads.js — test/uploads.test.js checks that they match.
 */

export const MAX_UPLOAD = 10 * 1024 * 1024;
export const PROXY_MAX = 4 * 1024 * 1024;
export const MAX_MB = MAX_UPLOAD / (1024 * 1024);
// What a photo may weigh before it is shrunk. Well past any phone camera.
export const MAX_PHOTO_SOURCE = 40 * 1024 * 1024;

// What may be sent, what to call it, and whether this browser can preview it.
export const UPLOAD_KINDS = {
  'image/webp': { label: 'WebP', preview: true },
  'image/jpeg': { label: 'JPG', preview: true },
  'image/png': { label: 'PNG', preview: true },
  'image/heic': { label: 'HEIC', preview: false },
  'image/heif': { label: 'HEIC', preview: false },
  'application/pdf': { label: 'PDF', preview: false },
};

// HEIC is left out on purpose. Given only these, an iPhone converts a HEIC
// photo to JPEG itself before handing it over; list HEIC and Safari hands
// over the HEIC — and converts JPEGs to it too.
export const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';

export const kb = (n) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// Some phones report no type at all for a photo, so the name is consulted too.
const IMAGE_NAME = /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i;
export const isImage = (file) => file.type.startsWith('image/') || (!file.type && IMAGE_NAME.test(file.name));

/** The type to send a file as. Some browsers report none for a .heic file. */
export const typeOf = (file) => file.type || (/\.hei[cf]$/i.test(file.name) ? 'image/heic' : '');

/**
 * Opens a picked photo for drawing.
 *
 * Through an <img> first: that is the path every browser has had longest, it
 * honours the photo's rotation, and it copes with a 48-megapixel camera shot
 * that createImageBitmap can run out of memory on in iOS Safari.
 */
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
    return {
      source: img, width: img.naturalWidth, height: img.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    if (typeof createImageBitmap !== 'function') throw err;
    const bmp = await createImageBitmap(file);
    return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close?.() };
  }
}

// A 2000px edge keeps the small print on a bank app screenshot legible —
// a phone screenshot is about 1170 × 2532 — while staying near 1 MB.
const MAX_EDGE = 2000;
const TARGET = 1024 * 1024;

/**
 * Shrinks a photo in the browser, which also strips camera metadata such as
 * location. Returns the original if it is not an image, or if this browser
 * cannot decode or encode it (a HEIC outside Safari, say) — the server then
 * decides.
 */
export async function downscale(file) {
  if (!isImage(file)) return file;
  try {
    const pic = await decodeImage(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(pic.width, pic.height));
    const w = Math.max(1, Math.round(pic.width * scale));
    const h = Math.max(1, Math.round(pic.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: false });
    // A transparent PNG would otherwise come out on black once it is a JPEG.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(pic.source, 0, 0, w, h);
    pic.release();

    // Safari — and so every browser on an iPhone or iPad — cannot encode
    // WebP. Asked for it, canvas.toBlob quietly hands back a PNG instead, so
    // the format is settled by what actually comes back.
    const encode = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    const probe = await encode('image/webp', 0.72);
    const format = probe?.type === 'image/webp' ? 'image/webp' : 'image/jpeg';

    // Step quality down gradually so text and QR codes stay readable; the
    // smallest result that was tried wins if none reaches the target.
    const qualities = format === 'image/webp' ? [0.72, 0.62, 0.52, 0.42] : [0.8, 0.7, 0.6, 0.5];
    let best = null;
    for (const quality of qualities) {
      const blob = quality === 0.72 && format === 'image/webp' ? probe : await encode(format, quality);
      if (!blob || blob.type !== format) continue;
      if (!best || blob.size < best.size) best = blob;
      if (blob.size <= TARGET) break;
    }
    if (!best) throw new Error('This browser could not encode the image');

    return new File(
      [best],
      file.name.replace(/\.[^.]+$/, '') + (format === 'image/webp' ? '.webp' : '.jpg'),
      { type: format, lastModified: Date.now() });
  } catch {
    return file;
  }
}

/** An error whose message is fit to show the runner. */
class UploadError extends Error {}

const readJson = (res) => res.json().catch(() => ({}));

async function postJson(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new UploadError('Network error while uploading. Please try again.');
  }
  // The platform itself can answer with a page rather than JSON (a time-out,
  // an over-size body), so the body is read defensively.
  const data = await readJson(res);
  if (!res.ok || !data.ok) throw new UploadError(data.error || 'Upload failed. Please try again.');
  return data;
}

/** PUTs the bytes to Google with progress, which a fetch cannot report. */
function putToDrive(url, file, type, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', type);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* checked below */ }
      if (xhr.status >= 200 && xhr.status < 300 && data.id) return resolve(String(data.id));
      reject(new UploadError('Upload failed. Please try again.'));
    };
    xhr.onerror = () => reject(new UploadError('Network error while uploading. Please try again.'));
    xhr.ontimeout = xhr.onerror;
    xhr.send(file);
  });
}

/**
 * Sends a prepared file (after downscale) and resolves with { id, size }.
 * Rejects with an Error whose message can be shown as it is.
 * `onProgress` receives a fraction from 0 to 1 while bytes are moving.
 */
export async function sendReceipt(file, { type = typeOf(file), onProgress } = {}) {
  if (!UPLOAD_KINDS[type]) throw new UploadError('Please use a JPG, PNG, WEBP or HEIC photo, or a PDF.');
  if (!file.size) throw new UploadError('That file is empty. Please choose another.');
  if (file.size > MAX_UPLOAD) {
    throw new UploadError(`That file is ${kb(file.size)}. Please keep it under ${MAX_MB} MB.`);
  }

  if (file.size <= PROXY_MAX) {
    let res;
    try {
      res = await fetch('/api/drive-upload', {
        method: 'POST',
        // Encoded: a header may only carry Latin-1, and a file name with
        // anything else in it — an emoji, or the narrow space macOS puts in
        // "9.41 PM" — made fetch throw before a byte was sent.
        headers: { 'Content-Type': type, 'X-Filename': encodeURIComponent(file.name) },
        body: file,
      });
    } catch {
      throw new UploadError('Network error while uploading. Please try again.');
    }
    const data = await readJson(res);
    if (!res.ok || !data.ok || !data.id) throw new UploadError(data.error || 'Upload failed. Please try again.');
    onProgress?.(1);
    return { id: String(data.id), size: data.size ?? file.size };
  }

  const started = await postJson('/api/upload-session', {
    action: 'start', type, size: file.size, name: file.name,
  });
  const id = await putToDrive(started.uploadUrl, file, type, onProgress);
  const done = await postJson('/api/upload-session', { action: 'finish', id, ticket: started.ticket });
  return { id: String(done.id), size: done.size ?? file.size };
}
