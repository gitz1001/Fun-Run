import { getAccessToken } from './google-auth.js';

const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

export function driveConfigured() {
  return Boolean(process.env.GOOGLE_DRIVE_FOLDER_ID && process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);
}

function folderId() {
  const id = String(process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();
  if (!id) throw new Error('GOOGLE_DRIVE_FOLDER_ID is not configured.');
  return id;
}

async function driveFetch(url, options = {}) {
  const token = await getAccessToken();
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, { ...options, headers });
}

export async function uploadToDrive({ buffer, filename, contentType }) {
  const boundary = `sfo_drive_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const metadata = {
    name: filename,
    parents: [folderId()],
  };

  const head = Buffer.from(
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    `--${boundary}\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([head, buffer, tail]);

  const res = await driveFetch(`${DRIVE_UPLOAD}?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,size`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    const message = data?.error?.message || `Google Drive upload failed (HTTP ${res.status})`;
    const err = new Error(message);
    err.code = data?.error?.code || res.status;
    throw err;
  }
  return data;
}

/**
 * Opens a resumable upload session for exactly one file, and returns the
 * session URL the browser then sends the bytes to.
 *
 * The URL is a capability for that one file only: it can create nothing else,
 * read nothing, and lasts about a week at most — the ticket the server signs
 * alongside it expires far sooner. `origin` is the page the browser is on;
 * Google answers the browser's PUT with CORS headers for that origin and no
 * other, which is what lets the upload skip this app's servers entirely.
 */
export async function startResumableUpload({ filename, contentType, size, origin }) {
  const headers = {
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Upload-Content-Type': contentType,
    'X-Upload-Content-Length': String(size),
  };
  if (origin) headers.Origin = origin;
  const res = await driveFetch(
    `${DRIVE_UPLOAD}?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: filename, parents: [folderId()], mimeType: contentType }),
    });
  const url = res.headers.get('location');
  if (!res.ok || !url) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error?.message || `Google Drive upload session failed (HTTP ${res.status})`);
  }
  return url;
}

/** Name, size, type and folder of one file, or null if Drive has no such file. */
export async function getDriveFileInfo(fileId) {
  const id = String(fileId || '').trim();
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) return null;
  const res = await driveFetch(
    `${DRIVE_FILES}/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id,name,mimeType,size,parents,trashed`,
    { method: 'GET' });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Google Drive metadata lookup failed (HTTP ${res.status})`);
  }
  const data = await res.json();
  return {
    id: data.id,
    name: data.name,
    mimeType: data.mimeType,
    size: Number(data.size),
    trashed: Boolean(data.trashed),
    inFolder: Array.isArray(data.parents) && data.parents.includes(folderId()),
  };
}

/** The first `bytes` bytes of a file — enough to tell what it really is. */
export async function readDriveHead(fileId, bytes = 16) {
  const id = String(fileId || '').trim();
  const res = await driveFetch(`${DRIVE_FILES}/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, {
    method: 'GET',
    headers: { Range: `bytes=0-${bytes - 1}` },
  });
  if (!res.ok) throw new Error(`Google Drive read failed (HTTP ${res.status})`);
  // A server that ignores Range sends everything; only the start is kept.
  return Buffer.from(await res.arrayBuffer()).subarray(0, bytes);
}

export async function getDriveFile(fileId) {
  const id = String(fileId || '').trim();
  if (!id) return null;
  const res = await driveFetch(`${DRIVE_FILES}/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, {
    method: 'GET',
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Google Drive download failed (HTTP ${res.status})`);
  }
  return res;
}

export async function getDriveFileMetadata(fileId) {
  const id = String(fileId || '').trim();
  if (!id) return null;
  const res = await driveFetch(`${DRIVE_FILES}/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id,name,mimeType,size`, {
    method: 'GET',
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Google Drive metadata lookup failed (HTTP ${res.status})`);
  }
  return res.json();
}

/**
 * Deletes one file, permanently — Drive's delete does not go through the bin.
 *
 * Takes a bare file id and nothing else. Callers pass ids from the uploads
 * table (lib/db.js), never a value a browser sent: this used to dig an id out
 * of any URL it was handed, which let a submitted link choose what got deleted.
 */
export async function deleteDriveFile(fileId) {
  const id = String(fileId || '').trim();
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) return false;
  // The folder receipts live in is never a receipt.
  if (id === String(process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim()) return false;
  const res = await driveFetch(`${DRIVE_FILES}/${encodeURIComponent(id)}?supportsAllDrives=true`, { method: 'DELETE' });
  if (res.status === 404) return true;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Google Drive delete failed (HTTP ${res.status})`);
  }
  return true;
}

/**
 * Is this an existing file sitting directly in the receipts folder? Used to
 * recognise a receipt that was uploaded just before the uploads table existed.
 */
export async function receiptInFolder(fileId) {
  const id = String(fileId || '').trim();
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) return false;
  const res = await driveFetch(`${DRIVE_FILES}/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id,parents,trashed,mimeType`, {
    method: 'GET',
  });
  if (!res.ok) return false;
  const data = await res.json().catch(() => ({}));
  return data.id === id && !data.trashed &&
    data.mimeType !== 'application/vnd.google-apps.folder' &&
    Array.isArray(data.parents) && data.parents.includes(folderId());
}

export async function checkDrive() {
  const id = folderId();
  const res = await driveFetch(`${DRIVE_FILES}/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id,name,mimeType,trashed`, {
    method: 'GET',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    throw new Error(data?.error?.message || `Google Drive folder check failed (HTTP ${res.status})`);
  }
  if (data.trashed) throw new Error('The configured Google Drive folder is in the trash.');
  if (data.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID does not point to a Google Drive folder.');
  }
  return data;
}
