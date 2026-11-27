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
