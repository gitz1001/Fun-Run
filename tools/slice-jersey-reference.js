/**
 * Slices assets-src/reference/reference_shirt.png into the twelve per-category jersey views the 3D
 * viewer loads, and knocks the white page background out to transparency so
 * the artwork sits on the viewer's own stage rather than in a white box.
 *
 *   node tools/slice-jersey-reference.js [source.png] [out-dir]
 *
 * Written against Node's own zlib rather than an image library: this repo has
 * no build step and no image dependency, and adding one for a job that runs
 * once would be a poor trade. Handles 8-bit RGBA, non-interlaced PNGs — which
 * is what the artwork arrives as.
 *
 * The jerseys are found rather than measured: the page background is flood
 * filled from the edges, what is left is grouped into connected shapes, and
 * the twelve big ones are the garments. So a redrawn reference sheet with the
 * panels in slightly different places still slices correctly; only the number
 * of jerseys and their reading order matter.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SRC = process.argv[2] || 'assets-src/reference/reference_shirt.png';
const OUT = process.argv[3] || 'public/shirt/jersey';

/** Reading order of the reference sheet: four rows of one category each. */
const CATEGORIES = ['1k', '3k', '5k', '10k'];
/** Within a category, the three garments are front, side, and back, in that order. */
const VIEWS = ['front', 'side', 'back'];

/** A pixel this pale on all three channels is page, not garment. */
const WHITE = 232;
/**
 * How far below that threshold the edge ramp runs: a frontier pixel at
 * WHITE is fully transparent, one at WHITE - SOFT fully opaque.
 */
const SOFT = 90;
/** Breathing room kept around each garment, in pixels. */
const PAD = 8;
/** Anything smaller than this is a caption, not a jersey. */
const MIN_W = 60;
const MIN_H = 120;
/**
 * A garment fills most of the box drawn round it. The panel rules do not —
 * they are hairlines whose box happens to be the whole sheet — so how solid a
 * shape is, not how big, is what separates artwork from furniture.
 */
const MIN_FILL = 0.3;

/* ---------- PNG ---------- */

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${SRC}: not a PNG`);
  let o = 8, head = null;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.subarray(o + 4, o + 8).toString('latin1');
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      head = {
        w: data.readUInt32BE(0), h: data.readUInt32BE(4),
        depth: data[8], color: data[9], interlace: data[12],
      };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (!head) throw new Error(`${SRC}: no IHDR`);
  if (head.depth !== 8 || head.color !== 6 || head.interlace !== 0) {
    throw new Error(`${SRC}: need an 8-bit RGBA non-interlaced PNG ` +
      `(got depth ${head.depth}, colour type ${head.color})`);
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { w, h } = head;
  const stride = w * 4;
  const px = Buffer.alloc(stride * h);

  // Undo the per-scanline filters. Each byte is predicted from its left (a),
  // upper (b) and upper-left (c) neighbours in the already-decoded output.
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const row = y * stride;
    const up = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[row + x - 4] : 0;
      const b = y ? px[up + x] : 0;
      const c = y && x >= 4 ? px[up + x - 4] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const q = a + b - c;
        const pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (ft !== 0) throw new Error(`${SRC}: unknown filter ${ft} on row ${y}`);
      px[row + x] = v & 255;
    }
  }
  return { w, h, px };
}

function encodePng(w, h, px) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                        // filter: none
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, 'latin1');
    data.copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;                                        // bit depth
  ihdr[9] = 6;                                        // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- finding the garments ---------- */

/**
 * Marks every page pixel reachable from the edges. Flooding rather than
 * testing colour is what saves the white 1K jersey: its body is just as pale
 * as the page, but the drawn outline encloses it, so the fill never gets in.
 */
function floodBackground(w, h, px) {
  const bg = new Uint8Array(w * h);
  const pale = (i) => px[i * 4] >= WHITE && px[i * 4 + 1] >= WHITE && px[i * 4 + 2] >= WHITE;
  const stack = [];
  const push = (i) => { if (!bg[i] && pale(i)) { bg[i] = 1; stack.push(i); } };

  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }

  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  return bg;
}

/**
 * Turns the flood's hard yes/no into a per-pixel alpha, and recovers the ink
 * underneath it.
 *
 * A drawn outline does not stop dead at the page: it fades into it across a
 * pixel or two of anti-aliasing, and those in-between pixels are too dark for
 * the flood to claim. Cut on the flood alone and every garment keeps a ring of
 * pale grey — invisible on the white sheet it came from, a dotted halo the
 * moment it is stood on anything else.
 *
 * So the frontier pixels get an alpha ramped by how pale they are, and their
 * colour is un-mixed from the white they were blended with, which is what puts
 * a crisp dark edge back on the garment instead of a grey one.
 */
function feather(w, h, px, bg) {
  const alpha = new Uint8Array(w * h).fill(255);
  for (let i = 0; i < w * h; i++) if (bg[i]) alpha[i] = 0;

  // Two passes: once the first ring has been softened, whatever it was hiding
  // becomes the new frontier. Beyond two the ramp starts eating real ink.
  let clear = bg;
  for (let pass = 0; pass < 2; pass++) {
    const next = Uint8Array.from(clear);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (clear[i] || alpha[i] === 0) continue;

        let frontier = false;
        for (let dy = -1; dy <= 1 && !frontier; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (clear[ny * w + nx]) { frontier = true; break; }
          }
        }
        if (!frontier) continue;

        const lum = px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114;
        const a = Math.max(0, Math.min(255, Math.round(255 * (WHITE - lum) / SOFT)));
        alpha[i] = a;
        if (!a) { next[i] = 1; continue; }

        // The pixel on the sheet is ink laid over white at this coverage.
        // Undo the white to get the ink, or the edge stays washed out.
        const k = a / 255;
        for (let c = 0; c < 3; c++) {
          px[i * 4 + c] = Math.max(0, Math.min(255,
            Math.round((px[i * 4 + c] - 255 * (1 - k)) / k)));
        }
      }
    }
    clear = next;
  }
  return alpha;
}

/** Bounding boxes of the connected shapes the flood left behind. */
function shapes(w, h, bg) {
  const seen = new Uint8Array(w * h);
  const out = [];
  for (let s = 0; s < w * h; s++) {
    if (bg[s] || seen[s]) continue;
    let x0 = s % w, x1 = x0, y0 = (s / w) | 0, y1 = y0, area = 0;
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop();
      const x = i % w, y = (i / w) | 0;
      area++;
      if (x < x0) x0 = x; else if (x > x1) x1 = x;
      if (y < y0) y0 = y; else if (y > y1) y1 = y;
      const step = (j) => { if (!bg[j] && !seen[j]) { seen[j] = 1; stack.push(j); } };
      if (x > 0) step(i - 1);
      if (x < w - 1) step(i + 1);
      if (y > 0) step(i - w);
      if (y < h - 1) step(i + w);
    }
    out.push({ x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
  }
  return out;
}

/**
 * Puts the garments in reading order: rows first, then left to right within a
 * row. Two jerseys belong to the same row when their vertical spans overlap,
 * which survives the panels not being pixel-aligned with each other.
 */
function readingOrder(list) {
  const rows = [];
  for (const s of [...list].sort((a, b) => a.y0 - b.y0)) {
    const row = rows.find((r) => s.y0 <= r.y1 && s.y1 >= r.y0);
    if (row) {
      row.items.push(s);
      row.y0 = Math.min(row.y0, s.y0);
      row.y1 = Math.max(row.y1, s.y1);
    } else rows.push({ y0: s.y0, y1: s.y1, items: [s] });
  }
  return rows.flatMap((r) => r.items.sort((a, b) => a.x0 - b.x0));
}

/** Copies one bounding box out, with the page turned transparent. */
function cut(src, alpha, box) {
  const x0 = Math.max(0, box.x0 - PAD), y0 = Math.max(0, box.y0 - PAD);
  const x1 = Math.min(src.w - 1, box.x1 + PAD), y1 = Math.min(src.h - 1, box.y1 + PAD);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y0 + y) * src.w + (x0 + x);
      const d = (y * w + x) * 4;
      if (!alpha[s]) continue;                        // page: leave fully clear
      px[d] = src.px[s * 4];
      px[d + 1] = src.px[s * 4 + 1];
      px[d + 2] = src.px[s * 4 + 2];
      px[d + 3] = alpha[s];
    }
  }
  return { w, h, px };
}

/* ---------- run ---------- */

const src = decodePng(fs.readFileSync(SRC));
const bg = floodBackground(src.w, src.h, src.px);
// feather() rewrites the frontier pixels in place, so the shapes are found on
// the flood mask — which it does not touch — and only the cut sees the ramp.
const alpha = feather(src.w, src.h, src.px, bg);
const found = shapes(src.w, src.h, bg).filter((s) => s.w >= MIN_W && s.h >= MIN_H && s.area / (s.w * s.h) >= MIN_FILL);

const want = CATEGORIES.length * VIEWS.length;
if (found.length !== want) {
  console.error(`Expected ${want} jerseys in ${SRC}, found ${found.length}:`);
  for (const s of found) console.error(`  ${s.w}x${s.h} at ${s.x0},${s.y0}`);
  console.error('\nAdjust MIN_W / MIN_H, or slice this sheet by hand.');
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
readingOrder(found).forEach((box, i) => {
  const name = `${CATEGORIES[(i / VIEWS.length) | 0]}-${VIEWS[i % VIEWS.length]}.png`;
  const img = cut(src, alpha, box);
  const file = path.join(OUT, name);
  fs.writeFileSync(file, encodePng(img.w, img.h, img.px));
  console.log(`${file}  ${img.w}x${img.h}`);
});
