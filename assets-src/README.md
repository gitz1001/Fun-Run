# Site assets — what goes where

Every picture and document the site loads, what it must be called, and what
happens when it is missing.

**These notes used to live as `README.txt` files inside `public/`.** They were
moved here because `public/` is the web root: anything in it is served to
anyone who asks for it, and internal notes naming file paths, caching rules
and open questions are not for the public. Nothing in `assets-src/` is
deployed — see `.vercelignore`.

The rule that follows from that: **`public/` holds only what the public is
meant to fetch.** Working files, sources and notes belong here instead.

---

## `public/logos/` — partner logos

    sisc.png   sfo.png   filinvest.png

Shown in the hero on both screens. Transparent PNGs: the page puts a glow
behind them with a drop-shadow that traces the actual silhouette, so a logo
on a white rectangle will show as a white rectangle. Served with a one-year
immutable cache, so change the filename if one is ever replaced.

## `public/causes/` — beneficiary photos

    pawikan-1.png   pawikan-2.png   pawikan-3.png
    bindoy-1.png    bindoy-2.png    bindoy-3.png

Shown in the "Where does Run For A Cause go?" pop-up on the front page,
cropped to 4:3. Around 800x600 each is plenty.

Any slot without a file shows a "Photo coming soon" placeholder instead, so
the page works whether you add none, some, or all six.

## `public/race/` — the race category poster

    race-categories.png

The picture that carries each distance and its registration fee. Shown whole,
never cropped, with a "Full size" link so the fees can be read on a phone.
Anything from around 1200px on its long side works; portrait and landscape
both fit. Keep it under about 400 KB.

With no file the slot shows a placeholder and hides the "Full size" link, so
the page still reads normally.

If the distances on the poster ever change, update the `race_category`
options in `lib/form-schema.js` and the `JERSEYS` map in `public/app.js` to
match.

## `public/shirt/jersey/` — the race jerseys

Twelve files, and only these twelve names:

    1k-front.png    1k-side.png    1k-back.png
    3k-front.png    3k-side.png    3k-back.png
    5k-front.png    5k-side.png    5k-back.png
    10k-front.png   10k-side.png   10k-back.png

The name comes from the `race_category` answers in `lib/form-schema.js`, in
lower case with the "K" kept: `1K` -> `1k`, `10K` -> `10k`. Add a distance
there and it also needs a colourway entry in the `JERSEYS` map in
`public/app.js`, or its shirt quietly stops being shown.

They are used twice: turned in 3D when a distance is picked, and stood
against the measurements in the size guide.

Requirements:

* **Transparent background.** The shirt is stood on the page's own surface,
  not pasted into a white box, and a white background will show as one
  against the dark theme.
* The garment filling the frame, no caption or distance label in the image —
  the page writes those itself.
* Front, side and back are framed consistently. The side artwork is used at the
  quarter-turns so the shirt keeps a convincing silhouette while it rotates.
* Roughly 3:4, portrait. Anything else is letterboxed, not cropped.
* Around 900px on the long side is plenty; keep each file under about 250 KB.
  There are eight and they all load at once.

The files there now were sliced out of `assets-src/reference/reference_shirt.png` by

    node tools/slice-jersey-reference.js

which is worth re-running if a new reference sheet arrives in the same
four-panel layout. They are only as good as that sheet — about 180px tall —
so they are placeholders. Drop the printer's artwork in over them under the
same names and nothing else has to change.

With a file missing the viewer steps aside and says "Jersey artwork coming
soon", so the question still works.

## The shirt size guide — no longer a picture

The "Shirt size" question used to show `public/shirt/shirt-size.png`: one
flat chart with the garment and the measurements baked into its pixels. It is
now drawn by the page, because the picture had gone wrong in a way a picture
cannot warn you about — it showed a purple sleeveless RACE SINGLET branded
"35 YEARS", where the 2026 race shirt is a sleeved raglan tee in four
colourways. Runners were choosing a size against a garment nobody receives.

What replaced it:

* The shirt in the guide is the same file the 3D viewer loads, from
  `public/shirt/jersey/`, in the colourway for the distance picked. The
  picture cannot disagree with the garment because it **is** the garment.
* The measurements are text, in a table, readable on a phone without opening
  anything. Picking a size lights up its row and puts its figures on the two
  brackets beside the shirt.
* The numbers live in `lib/form-schema.js`, on the `shirt_size` field, beside
  the list of sizes they describe — so the two cannot drift apart.

To add a third measurement (a sleeve length, say): add the key to every size
under `sizeChart.measurements` in `lib/form-schema.js`, and add a matching
entry to `SIZE_COLUMNS` in `public/app.js`. The table builds itself from that
list. Only width and length get a bracket on the drawing — they are the two
dimensions there is a picture to point at.

> **The measurements are unconfirmed.** They were taken off the singlet chart
> and are a perfectly even 16-24 / 24-32 ladder, which reads like a supplier's
> template rather than measured samples. Put a tape measure on an actual 2026
> shirt before the form goes live.

`shirt-size.png` is kept in this folder, unserved, in case the artwork is
wanted for a poster or a claim stub. Nothing on the site loads it.

## `public/payment/` — the payment method picture

    bank_transfer.png

Bank transfer is the only method with anything to show: SISC employees paying
by salary deduction have no account to pay into. The PNB account number is
also written out beside this image, in the markup, so the details are
readable and copyable even before the picture is added.

Shown uncropped in a square tile. With no file the tile shows a placeholder
and the account details beside it still read normally.

## `public/docs/` — the waiver

    official-waiver.pdf

Linked from "Before you register" on the front page, and referenced by name
from `public/index.html` — so replace the file in place rather than renaming
it.

Because the name never changes, the only thing that tells a browser it is
looking at a new document is the cache header. `vercel.json` serves `/docs/`
with `max-age=0, must-revalidate`, so a replacement is picked up on the next
visit. **Do not put a long `max-age` or `stale-while-revalidate` back on this
path**: readers who opened the old file would keep getting it, and this is
the document they are agreeing to.

If you have already opened the old version yourself, your own browser may
still hold it — reload the PDF tab with Ctrl+Shift+R (Cmd+Shift+R on a Mac).
