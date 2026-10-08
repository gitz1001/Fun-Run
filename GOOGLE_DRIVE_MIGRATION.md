# Google Drive receipt storage

This version replaces Vercel Blob receipt storage with Google Drive.

## Destination folder

`GOOGLE_DRIVE_FOLDER_ID=1ePnOM7bKACgqj4KZZVaRKiYUVz_a8f1A`

The folder should remain private. Staff view receipts through `/api/receipt?id=<Drive file ID>` after staff authentication. The route serves only files the app itself uploaded, which it tracks in the `uploads` table.

## Required environment variables

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
GOOGLE_DRIVE_FOLDER_ID=1ePnOM7bKACgqj4KZZVaRKiYUVz_a8f1A
```

The OAuth account used by `GOOGLE_REFRESH_TOKEN` must have permission to add files to the SFO-Payment folder.

## Google Cloud setup

Enable the **Google Drive API** in the same Google Cloud project used for Gmail/Sheets.
Then run:

```bash
npm run token
```

The token helper requests Gmail + Sheets + full Drive (`drive`) access — full, because the narrower `drive.file` scope cannot write into a folder the app did not create. Re-authorise once after this migration so the refresh token contains the Drive scope.

## Image format

The existing browser upload flow continues to convert/downscale images to WebP before upload. PDFs remain PDFs.

## Database

The `proof_url` column holds the app's own authenticated receipt URL, `<site>/api/receipt?id=<Drive file ID>`. The browser submits only the file ID; the server checks it against the `uploads` table and builds the URL itself. Rows written before this hold a `drive.google.com/file/d/...` link instead, which the dashboard still opens.

Uploads that never became a registration are listed, and with `--fix` deleted, by `npm run sweep`.

## Important

The old `.env.local` in the original project archive contains credentials. Do not deploy that file or commit it. Rotate any exposed Vercel Blob token and keep secrets only in Vercel environment variables/local ignored env files.
