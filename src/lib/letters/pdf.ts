import { PRODUCT } from '../product';
/**
 * Minimal, dependency-free PDF writer for plain-text letters (US Letter, Helvetica, automatic wrapping and pagination).
 * Intentionally simple: letters are text. Text uses WinAnsi so accented Latin characters (Spanish letters) render correctly.
 */
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 72;
const SIZE = 11;
const LEADING = 14.5;

// Helvetica advance widths (1/1000 em) for ASCII 32..126.
const W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

const WIN_ANSI: Record<string, number> = { '€': 0x80, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97 };

function toCode(ch: string): number {
  const c = ch.codePointAt(0)!;
  if (c >= 32 && c <= 126) return c;
  if (c >= 0xa0 && c <= 0xff) return c;
  return WIN_ANSI[ch] ?? 63; // '?'
}

const width = (s: string) => {
  let w = 0;
  for (const ch of s) {
    const c = toCode(ch);
    w += c >= 32 && c <= 126 ? W[c - 32]! : 556;
  }
  return (w / 1000) * SIZE;
};

function wrap(paragraph: string, max: number): string[] {
  if (paragraph.trim() === '') return [''];
  const indent = /^\s*/.exec(paragraph)![0].length;
  const words = paragraph.trim().split(/\s+/);
  const lines: string[] = [];
  let cur = ' '.repeat(Math.min(indent, 8));
  for (const word of words) {
    const test = cur.trim() ? `${cur} ${word}` : `${cur}${word}`;
    if (width(test) <= max || !cur.trim()) cur = test;
    else { lines.push(cur); cur = word; }
  }
  if (cur.trim()) lines.push(cur);
  return lines;
}

const esc = (s: string) => {
  let out = '';
  for (const ch of s) {
    const c = toCode(ch);
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (c < 128 && c >= 32) out += String.fromCharCode(c);
    else out += `\\${c.toString(8).padStart(3, '0')}`;
  }
  return out;
};

export function renderPdf(text: string, opts: { title?: string; footerNote?: string } = {}): Buffer {
  const maxW = PAGE_W - MARGIN * 2;
  const lines = text.replace(/\r\n?/g, '\n').split('\n').flatMap((p) => wrap(p, maxW));
  const perPage = Math.floor((PAGE_H - MARGIN * 2) / LEADING);
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (!pages.length) pages.push(['']);

  const objs: string[] = [];
  const add = (body: string) => { objs.push(body); return objs.length; };
  const catalog = add('<< /Type /Catalog /Pages 2 0 R >>'); // 1
  add(''); // 2 pages (patched below)
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); // 3
  const kids: number[] = [];
  pages.forEach((pl, idx) => {
    let s = 'BT\n/F1 ' + SIZE + ' Tf\n' + LEADING + ' TL\n' + MARGIN + ' ' + (PAGE_H - MARGIN) + ' Td\n';
    for (const l of pl) s += `(${esc(l)}) Tj T*\n`;
    s += 'ET\n';
    const footer = `${opts.footerNote ? `${opts.footerNote}   ` : ''}Page ${idx + 1} of ${pages.length}`;
    s += `BT\n/F1 8 Tf\n${MARGIN} 40 Td\n(${esc(footer)}) Tj\nET\n`;
    const content = add(`<< /Length ${Buffer.byteLength(s, 'latin1')} >>\nstream\n${s}endstream`);
    const page = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
    kids.push(page);
  });
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${esc((opts.title ?? 'Letter').slice(0, 120))}) /Producer (${esc(PRODUCT.name)}) >>`);

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
