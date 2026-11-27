import { extractText, getDocumentProxy } from 'unpdf';

/**
 * Pages one text PDF may have. A bureau's own disclosure is long: Experian prints about two and a half pages per
 * account, so 45 accounts are already past 100 pages. Reading is quick (about 1 second for 110 pages, 3 seconds for
 * 400, measured on generated reports), so the limit only keeps out files that are not a credit report.
 */
export const MAX_PDF_PAGES = 400;

/** `scanned` is set when the PDF opened but has no text layer (a scan), so a caller can hand it to OCR instead. */
export class PdfTextError extends Error {
  constructor(message: string, readonly scanned = false, readonly pages = 0) { super(message); }
}

export const SCANNED_PDF_MESSAGE = 'This PDF has no readable text (it may be a scan). Upload a text-based PDF, or use the CSV import.';

/**
 * Text extraction from a text-based PDF, every page, with the page count. Image-only (scanned) PDFs have no text
 * layer and are reported as such (PdfTextError.scanned); reading them is OCR's job (ocr.ts), done by the caller when
 * it is turned on.
 */
export async function readPdfText(bytes: Buffer): Promise<{ text: string; pages: number }> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const pages = pdf.numPages;
    if (pages > MAX_PDF_PAGES) throw new PdfTextError(`That PDF has ${pages} pages (limit ${MAX_PDF_PAGES}). Upload one bureau’s report at a time.`);
    const { text } = await extractText(pdf, { mergePages: true });
    const out = (Array.isArray(text) ? text.join('\n') : text).trim();
    if (out.length < 40) throw new PdfTextError(SCANNED_PDF_MESSAGE, true, pages);
    return { text: out, pages };
  } catch (e) {
    if (e instanceof PdfTextError) throw e;
    throw new PdfTextError('That PDF could not be read. It may be encrypted or damaged.');
  }
}

export async function pdfToText(bytes: Buffer): Promise<string> {
  return (await readPdfText(bytes)).text;
}

/** A run of words that sit together on a line, with where it starts and ends across the page (PDF points). */
export interface PdfCell { x: number; x2: number; s: string }
/** One line of a page as it is laid out: its cells left to right. `y` is measured down from the top of the page. */
export interface PdfLine { page: number; y: number; cells: PdfCell[] }

/**
 * The same text as it is laid out on the page rather than in the order the file stores it: every piece with where it
 * sits, grouped into lines top to bottom and into cells left to right. A report that prints a grid (labels in a row,
 * each value under its label) can only be read reliably this way: the stored order depends on how the PDF was made,
 * the positions do not.
 *
 * Pieces whose baselines are within a third of the type size are one line; pieces closer than about half the type
 * size are one cell, and a wider gap starts the next cell. Both tolerances are the ones the MIT-licensed Errata
 * project uses for its text layer (github.com/wjwhitmire/errata, src/errata/textlayer.py); the code is ours.
 */
export async function readPdfLines(bytes: Buffer): Promise<PdfLine[]> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    if (pdf.numPages > MAX_PDF_PAGES) throw new PdfTextError(`That PDF has ${pdf.numPages} pages (limit ${MAX_PDF_PAGES}). Upload one bureau’s report at a time.`);
    const out: PdfLine[] = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const height = page.getViewport({ scale: 1 }).height;
      const pieces: { x: number; y: number; w: number; h: number; s: string }[] = [];
      for (const it of (await page.getTextContent()).items) {
        if (!('str' in it) || !it.str.trim()) continue;
        const t = it.transform as number[];
        // Upright text only: a rotated watermark or margin note has no place in a line of the page.
        if (Math.abs(t[1] ?? 0) > 0.01 || Math.abs(t[2] ?? 0) > 0.01) continue;
        pieces.push({ x: t[4] ?? 0, y: height - (t[5] ?? 0), w: it.width, h: Math.abs(t[3] ?? 0) || it.height || 10, s: it.str });
      }
      pieces.sort((a, b) => a.y - b.y || a.x - b.x);
      let line: typeof pieces = [];
      const flush = () => {
        if (!line.length) return;
        const cells: PdfCell[] = [];
        for (const it of [...line].sort((a, b) => a.x - b.x)) {
          const last = cells[cells.length - 1];
          const gap = last ? it.x - last.x2 : Infinity;
          if (last && gap <= 0.45 * it.h) {
            last.s += (gap < 0.12 * it.h || /\s$/.test(last.s) || /^\s/.test(it.s) ? '' : ' ') + it.s;
            last.x2 = Math.max(last.x2, it.x + it.w);
          } else cells.push({ x: it.x, x2: it.x + it.w, s: it.s });
        }
        const kept = cells.map((c) => ({ ...c, s: c.s.replace(/\s+/g, ' ').trim() })).filter((c) => c.s);
        if (kept.length) out.push({ page: p, y: line[0]!.y, cells: kept });
        line = [];
      };
      for (const it of pieces) {
        if (line.length && Math.abs(it.y - line[0]!.y) > Math.max(2, 0.35 * it.h)) flush();
        line.push(it);
      }
      flush();
    }
    return out;
  } catch (e) {
    if (e instanceof PdfTextError) throw e;
    throw new PdfTextError('That PDF could not be read. It may be encrypted or damaged.');
  }
}
