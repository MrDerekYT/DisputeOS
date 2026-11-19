import { extractText, getDocumentProxy } from 'unpdf';

const MAX_PAGES = 80;

export class PdfTextError extends Error {}

/**
 * Text extraction from a text-based PDF. Image-only (scanned) PDFs have no text layer and are reported as such;
 * OCR is not implemented — use the CSV import or a text-based export from the bureau.
 */
export async function pdfToText(bytes: Buffer): Promise<string> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    if (pdf.numPages > MAX_PAGES) throw new PdfTextError(`That PDF has ${pdf.numPages} pages (limit ${MAX_PAGES}).`);
    const { text } = await extractText(pdf, { mergePages: true });
    const out = (Array.isArray(text) ? text.join('\n') : text).trim();
    if (out.length < 40) throw new PdfTextError('This PDF has no readable text (it may be a scan). Upload a text-based PDF, or use the CSV import.');
    return out;
  } catch (e) {
    if (e instanceof PdfTextError) throw e;
    throw new PdfTextError('That PDF could not be read. It may be encrypted or damaged.');
  }
}
