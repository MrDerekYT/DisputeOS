import { extractText, getDocumentProxy } from 'unpdf';

const MAX_PAGES = 80;

/** `scanned` is set when the PDF opened but has no text layer (a scan), so a caller can hand it to OCR instead. */
export class PdfTextError extends Error {
  constructor(message: string, readonly scanned = false, readonly pages = 0) { super(message); }
}

export const SCANNED_PDF_MESSAGE = 'This PDF has no readable text (it may be a scan). Upload a text-based PDF, or use the CSV import.';

/**
 * Text extraction from a text-based PDF. Image-only (scanned) PDFs have no text layer and are reported as such
 * (PdfTextError.scanned); reading them is OCR's job (ocr.ts), done by the caller when it is turned on.
 */
export async function pdfToText(bytes: Buffer): Promise<string> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    if (pdf.numPages > MAX_PAGES) throw new PdfTextError(`That PDF has ${pdf.numPages} pages (limit ${MAX_PAGES}).`);
    const { text } = await extractText(pdf, { mergePages: true });
    const out = (Array.isArray(text) ? text.join('\n') : text).trim();
    if (out.length < 40) throw new PdfTextError(SCANNED_PDF_MESSAGE, true, pdf.numPages);
    return out;
  } catch (e) {
    if (e instanceof PdfTextError) throw e;
    throw new PdfTextError('That PDF could not be read. It may be encrypted or damaged.');
  }
}
