import { refund, settle, spend } from '../ai/credits';
import { detectLayout, parseBureauLayout, parseTransUnionAcr, readingScore, tuTextFromLines } from './bureau-layouts';
import { htmlToText, MAX_TEXT, parseReportText, parseTradelineCsv } from './parser';
import { PdfTextError, readPdfLines, readPdfText, SCANNED_PDF_MESSAGE } from './pdf-text';
import { isScanMime, MAX_SCAN_PAGES, OcrError, ocrEnabled, ocrReport, SCAN_FIELD_CONFIDENCE, SCAN_WARNING, type ScanMime } from './ocr';
import type { ParsedReport } from './types';

/** A file staff can upload as a report. Images are only accepted while AI reading is turned on. */
export const REPORT_TEXT_MIMES = ['application/pdf', 'text/plain', 'text/html', 'text/csv'] as const;
export const REPORT_IMAGE_MIMES = ['image/png', 'image/jpeg'] as const;
export const reportMimes = (): string[] => (ocrEnabled() ? [...REPORT_TEXT_MIMES, ...REPORT_IMAGE_MIMES] : [...REPORT_TEXT_MIMES]);

/** Something staff should see as is (wrong file, AI reading off, no credits...). */
export class ReportReadError extends Error {}

export const SCANS_OFF_IMAGE = 'A photo or scan cannot be read: reading reports with AI is not turned on. Ask the client for the PDF downloaded from the bureau, or use the CSV import.';
export const NO_SCAN_CREDITS = 'Reading this report needs AI, which takes AI credits, and your workspace has none left. Add credits, or use the CSV template.';
export const LAYOUT_NOT_KNOWN = 'The accounts in this report could not be recognised: its layout is not one the built-in reader knows, and reading reports with AI is not turned on. Use the CSV template, or ask the platform operator to turn on AI reading (OCR_PROVIDER).';
export const TOO_MUCH_TEXT = 'This file has more text than can be read at once, and it is not in a bureau layout the built-in reader knows. Upload one bureau’s report at a time, or use the CSV template.';
export const AI_READ_WARNING = 'Read by AI from the bureau’s own layout: check every field against the original before approving.';

export interface ReportFile { bytes: Buffer; mime: string; name: string }
export interface Payer { orgId: string; userId: string }
/**
 * `via`: how the accounts were read — a bureau's exact layout reader, the rules parser, AI from the report's text, or
 * AI from a scan/photo. `pages`: how many pages the PDF has; absent for other files. For 'layout' and 'rules' the text
 * of every one of them was read (pagesNote says what may be claimed).
 */
export interface ReadResult { parsed: ParsedReport; via: 'layout' | 'rules' | 'ai_text' | 'ai_scan'; pages?: number }

/**
 * What the upload result says about pages. "All N pages read" is only said where it is true by construction: the text
 * of every page was taken out here and read by rules. A file read by AI is described by its length, nothing more.
 */
export function pagesNote(r: Pick<ReadResult, 'via' | 'pages'>): string {
  if (!r.pages) return '';
  if (r.via === 'layout' || r.via === 'rules') return r.pages === 1 ? ', 1 page read' : `, all ${r.pages} pages read`;
  return `, ${r.pages}-page file`;
}

export interface ReadDeps {
  ocr?: typeof ocrReport;
  enabled?: () => boolean;
  credits?: { spend: typeof spend; settle: typeof settle; refund: typeof refund };
}

/** AnnualCreditReport.com and the bureaus' own disclosures: their layouts are read by AI even when the rules find something. */
const BUREAU_DISCLOSURE = /annual\s*credit\s*report|annualcreditreport\.com|consumer\s+disclosure|prepared\s+for\b|personal\s+credit\s+report|report\s+number|confirmation\s*#|file\s+number/i;

const found = (p: ParsedReport) => p.tradelines.length + p.inquiries.length + p.publicRecords.length;

/**
 * Reads any accepted report file, every page of it. The three bureaus' own free-report layouts go to their exact
 * readers (free, no AI). Anything else goes to the rules parser (free, exact). When that recognises no accounts, or the
 * file is a bureau's own disclosure in a layout without a reader, and AI reading is on, the AI rewrites the report into
 * the parser's fixed "Label: value" layout and the parser files each value into its field. Scans and photos always go
 * through AI. Anything read by AI has every field flagged for a person to check.
 */
export async function readReportFile(file: ReportFile, payer: Payer, deps: ReadDeps = {}): Promise<ReadResult> {
  const enabled = deps.enabled ?? ocrEnabled;
  if (file.mime === 'text/csv' || /\.csv$/i.test(file.name)) return { parsed: parseTradelineCsv(file.bytes.toString('utf8')), via: 'rules' };

  let text: string;
  let pages: number | undefined;
  if (file.mime === 'text/plain' || file.mime === 'text/html') {
    const raw = file.bytes.toString('utf8');
    text = file.mime === 'text/html' ? htmlToText(raw) : raw;
  } else if (file.mime === 'application/pdf') {
    try {
      ({ text, pages } = await readPdfText(file.bytes));
    } catch (e) {
      if (!(e instanceof PdfTextError)) throw e;
      if (!e.scanned || !enabled()) throw new ReportReadError(e.message);
      if (e.pages > MAX_SCAN_PAGES) throw new ReportReadError(`This scan has ${e.pages} pages. Up to ${MAX_SCAN_PAGES} pages can be read at once: split it and upload the parts.`);
      return { parsed: await readWithAi({ bytes: file.bytes, mime: 'application/pdf' }, payer, deps, SCAN_WARNING), via: 'ai_scan', pages: e.pages || undefined };
    }
  } else if (isScanMime(file.mime)) {
    if (!enabled()) throw new ReportReadError(SCANS_OFF_IMAGE);
    return { parsed: await readWithAi({ bytes: file.bytes, mime: file.mime as ScanMime }, payer, deps, SCAN_WARNING), via: 'ai_scan' };
  } else {
    throw new ReportReadError('Only a PDF, photo, text, HTML or CSV file can be read as a report.');
  }

  // The bureaus' own free-report layouts (Experian, Equifax, TransUnion) have exact readers: free, no AI, fixed fields.
  let bureau = parseBureauLayout(text);
  if (file.mime === 'application/pdf' && detectLayout(text) === 'transunion_acr') {
    // TransUnion prints each account as a grid, and the order a PDF stores that grid's text in depends on how the file
    // was made. So the file is read a second time from where the text sits on the page, and the reading that filled
    // in more of the accounts is kept. If the second reading cannot be made, the first one stands.
    try {
      const byPosition = parseTransUnionAcr(tuTextFromLines(await readPdfLines(file.bytes)));
      if (!bureau || readingScore(byPosition) > readingScore(bureau)) bureau = byPosition;
    } catch (e) {
      if (!(e instanceof PdfTextError)) throw e;
    }
  }
  if (bureau && found(bureau)) return { parsed: bureau, via: 'layout', pages };

  if (text.length > MAX_TEXT) throw new ReportReadError(TOO_MUCH_TEXT);
  const rules = parseReportText(text);
  const disclosure = BUREAU_DISCLOSURE.test(text.slice(0, 5000));
  const needsAi = rules.tradelines.length === 0 || disclosure;
  if (!needsAi) return { parsed: rules, via: 'rules', pages };
  if (!enabled()) {
    // A bureau's own disclosure in which the rules found no account at all: whatever else they picked up is lines of
    // the report that only look like inquiries (a heading's explanation, an address), so nothing is imported.
    // The same holds for a PDF that names a bureau: a PDF is a printout of a report, not a list someone typed, so one
    // with no account read is a layout the rules do not know. (A typed text file that lists inquiries only is still read.)
    const bureauPdf = file.mime === 'application/pdf' && /\b(?:equifax|experian|trans\s?union)\b/i.test(text.slice(0, 600));
    const junk = rules.tradelines.length === 0 && (disclosure || bureauPdf);
    if (found(rules) && !junk) return { parsed: rules, via: 'rules', pages };
    throw new ReportReadError(LAYOUT_NOT_KNOWN);
  }
  return { parsed: await readWithAi({ text }, payer, deps, AI_READ_WARNING), via: 'ai_text', pages };
}

/** AI read with the credit rules every AI feature follows: reserve, then settle on success or refund on failure. */
async function readWithAi(input: { bytes: Buffer; mime: ScanMime } | { text: string }, payer: Payer, deps: ReadDeps, warning: string): Promise<ParsedReport> {
  const credits = deps.credits ?? { spend, settle, refund };
  const charge = await credits.spend(payer.orgId, 'report_scan', payer.userId);
  if (!charge.ok) throw new ReportReadError(NO_SCAN_CREDITS);
  let parsed: ParsedReport;
  try {
    parsed = markAiRead(parseReportText(await (deps.ocr ?? ocrReport)(input)), warning);
  } catch (e) {
    await credits.refund(payer.orgId, 'report_scan', payer.userId, 'Report could not be read', charge.id).catch(() => undefined);
    if (e instanceof OcrError) throw new ReportReadError(e.message);
    throw e;
  }
  if (!found(parsed) && !parsed.identity.length) {
    await credits.refund(payer.orgId, 'report_scan', payer.userId, 'Nothing recognised', charge.id).catch(() => undefined);
    throw new ReportReadError('The report was read, but no accounts, inquiries or records were recognised in it. No credits were used.');
  }
  await credits.settle(charge.id);
  return parsed;
}

/** Holds every field the AI read below the review threshold, so a person confirms each one before use. */
export function markAiRead(parsed: ParsedReport, warning: string = SCAN_WARNING): ParsedReport {
  for (const t of parsed.tradelines) {
    for (const m of Object.values(t.field_meta)) m.confidence = Math.min(m.confidence, SCAN_FIELD_CONFIDENCE);
    t.confidence = Math.min(t.confidence, SCAN_FIELD_CONFIDENCE);
  }
  parsed.warnings = [warning, ...parsed.warnings.filter((w) => !/may be scanned|image-only/i.test(w))];
  return parsed;
}
export { SCANNED_PDF_MESSAGE };
