import { PRODUCT } from '../product';
/**
 * Minimal, dependency-free PDF writer for plain-text letters (US Letter, Helvetica, automatic wrapping and pagination).
 * Intentionally simple: letters are text. Text uses WinAnsi so accented Latin characters (a client's name or address) render correctly.
 * renderPdfBlocks can set a paragraph in Helvetica-Bold (the copies of signed agreements need the statement of
 * 15 U.S.C. § 1679d(b)(4) and the Notice of Cancellation in bold). A document with no bold paragraph, such as every
 * letter, is written exactly as before: the second font is only added when something uses it.
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

// Helvetica-Bold advance widths (1/1000 em) for ASCII 32..126 (WinAnsi glyphs: 39 is quotesingle, 96 is grave).
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975,
  722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333,
  556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

const WIN_ANSI: Record<string, number> = { '€': 0x80, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97 };

function toCode(ch: string): number {
  const c = ch.codePointAt(0)!;
  if (c >= 32 && c <= 126) return c;
  if (c >= 0xa0 && c <= 0xff) return c;
  return WIN_ANSI[ch] ?? 63; // '?'
}

/**
 * The characters of `text` that this writer cannot print and puts on the page as "?" (anything outside ASCII, Latin-1
 * and the WinAnsi symbols above, such as "ễ", "Ł", "→" or "™"), each once, in order. White space never reaches the page
 * as such (lines are wrapped on it), so it is never one of them. Reading only: nothing about how a PDF is drawn changes.
 */
export function unprintable(text: string): string[] {
  return [...new Set([...text].filter((ch) => ch !== '?' && !/\s/.test(ch) && toCode(ch) === 63))];
}

const width = (s: string, bold = false) => {
  const table = bold ? W_BOLD : W;
  let w = 0;
  for (const ch of s) {
    const c = toCode(ch);
    // Characters outside ASCII are counted at a generous average, wider in bold, so a line never runs past the margin.
    w += c >= 32 && c <= 126 ? table[c - 32]! : bold ? 611 : 556;
  }
  return (w / 1000) * SIZE;
};

function wrap(paragraph: string, max: number, bold = false): string[] {
  if (paragraph.trim() === '') return [''];
  const indent = /^\s*/.exec(paragraph)![0].length;
  const words = paragraph.trim().split(/\s+/);
  const lines: string[] = [];
  let cur = ' '.repeat(Math.min(indent, 8));
  for (const word of words) {
    const test = cur.trim() ? `${cur} ${word}` : `${cur}${word}`;
    if (width(test, bold) <= max || !cur.trim()) cur = test;
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

export interface PdfOptions { title?: string; footerNote?: string }
/** A paragraph of a PDF; line breaks inside it are kept. `pageBreakBefore` starts it on a new page. */
export interface PdfBlock { text: string; bold?: boolean; pageBreakBefore?: boolean }

export function renderPdf(text: string, opts: PdfOptions = {}): Buffer {
  return renderPdfBlocks([{ text }], opts);
}

/** Like renderPdf, with some paragraphs in Helvetica-Bold. Blocks follow each other with no space added between them. */
export function renderPdfBlocks(blocks: PdfBlock[], opts: PdfOptions = {}): Buffer {
  const maxW = PAGE_W - MARGIN * 2;
  type Line = { text: string; bold: boolean; breakBefore?: boolean };
  const lines: Line[] = blocks.flatMap((b) => b.text.replace(/\r\n?/g, '\n').split('\n').flatMap((p) => wrap(p, maxW, !!b.bold).map((text) => ({ text, bold: !!b.bold }))).map((l, i) => (i === 0 && b.pageBreakBefore ? { ...l, breakBefore: true } : l)));
  const perPage = Math.floor((PAGE_H - MARGIN * 2) / LEADING);
  const pages: Line[][] = [];
  let page: Line[] = [];
  for (const l of lines) {
    if (page.length === perPage || (l.breakBefore && page.length > 0)) { pages.push(page); page = []; }
    page.push(l);
  }
  if (page.length) pages.push(page);
  if (!pages.length) pages.push([{ text: '', bold: false }]);
  const anyBold = lines.some((l) => l.bold);

  const objs: string[] = [];
  const add = (body: string) => { objs.push(body); return objs.length; };
  const catalog = add('<< /Type /Catalog /Pages 2 0 R >>'); // 1
  add(''); // 2 pages (patched below)
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); // 3
  const bold = anyBold ? add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>') : 0; // 4, only when used
  const fonts = `/F1 ${font} 0 R${anyBold ? ` /F2 ${bold} 0 R` : ''}`;
  const kids: number[] = [];
  pages.forEach((pl, idx) => {
    let s = 'BT\n/F1 ' + SIZE + ' Tf\n' + LEADING + ' TL\n' + MARGIN + ' ' + (PAGE_H - MARGIN) + ' Td\n';
    let inBold = false;
    for (const l of pl) {
      if (l.bold !== inBold) { s += `/${l.bold ? 'F2' : 'F1'} ${SIZE} Tf\n`; inBold = l.bold; }
      s += `(${esc(l.text)}) Tj T*\n`;
    }
    s += 'ET\n';
    const footer = `${opts.footerNote ? `${opts.footerNote}   ` : ''}Page ${idx + 1} of ${pages.length}`;
    s += `BT\n/F1 8 Tf\n${MARGIN} 40 Td\n(${esc(footer)}) Tj\nET\n`;
    const content = add(`<< /Length ${Buffer.byteLength(s, 'latin1')} >>\nstream\n${s}endstream`);
    const page = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << ${fonts} >> >> /Contents ${content} 0 R >>`);
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
