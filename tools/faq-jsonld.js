/**
 * Rewrites the FAQPage data in the <head> of public/index.html from the FAQ
 * section further down the same page, so the two cannot disagree.
 *
 *   node tools/faq-jsonld.js
 *
 * Run it after adding, removing or rewording a question. test/rules.test.js
 * fails while the questions in the two places differ.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../public/index.html', import.meta.url));
const page = readFileSync(file, 'utf8');

const start = page.indexOf('<section class="section faq"');
if (start < 0) throw new Error('No FAQ section found in public/index.html.');
const faq = page.slice(start, page.indexOf('</section>', start));

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const unescape = (s) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m]);

/** An answer's HTML as one line of plain text; a table becomes "a: b; c: d." */
function plain(html) {
  const text = unescape(html
    .replace(/<thead>[\s\S]*?<\/thead>/g, '')
    .replace(/<span class="faq-sub">\(?([^<)]*)\)?<\/span>/g, ' ($1)')
    .replace(/<\/th>\s*<td>/g, ': ')
    .replace(/<\/tr>/g, '; ')
    .replace(/<\/(p|li)>/g, '\n')
    .replace(/<[^>]+>/g, ''));
  return text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ')
    .replace(/\s+;/g, ';').replace(/;\s*$/, '.').trim();
}

const items = [...faq.matchAll(/<summary>([\s\S]*?)<\/summary>\s*<div class="faq-a">([\s\S]*?)<\/div>\s*<\/details>/g)];
const data = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: items.map(([, q, a]) => ({
    '@type': 'Question',
    name: unescape(q.trim()),
    acceptedAnswer: { '@type': 'Answer', text: plain(a) },
  })),
};

const blocks = [...page.matchAll(/(<script type="application\/ld\+json">\n)([\s\S]*?)(\n<\/script>)/g)];
const old = blocks.find((b) => b[2].includes('"FAQPage"'));
if (!old) throw new Error('No FAQPage block found in the <head> to replace.');
writeFileSync(file, page.replace(old[2], JSON.stringify(data, null, 2)));
console.log(`FAQPage data rewritten: ${items.length} questions.`);
