import { refund, settle, spend } from '../ai/credits';
import { parseBureauLayout } from './bureau-layouts';
import { htmlToText, parseReportText, parseTradelineCsv } from './parser';
import { PdfTextError, pdfToText, SCANNED_PDF_MESSAGE } from './pdf-text';
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
export const AI_READ_WARNING = 'Read by AI from the bureau’s own layout: check every field against the original before approving.';

export interface ReportFile { bytes: Buffer; mime: string; name: string }
export interface Payer { orgId: string; userId: string }
/** `via`: how the accounts were read — the rules parser, AI from the report's text, or AI from a scan/photo. */
export interface ReadResult { parsed: ParsedReport; via: 'layout' | 'rules' | 'ai_text' | 'ai_scan' }

export interface ReadDeps {
  ocr?: typeof ocrReport;
  enabled?: () => boolean;
  credits?: { spend: typeof spend; settle: typeof settle; refund: typeof refund };
}

/** AnnualCreditReport.com and the bureaus' own disclosures: their layouts are read by AI even when the rules find something. */
const BUREAU_DISCLOSURE = /annual\s*credit\s*report|annualcreditreport\.com|consumer\s+disclosure|prepared\s+for\b|personal\s+credit\s+report|report\s+number|confirmation\s*#|file\s+number/i;

const found = (p: ParsedReport) => p.tradelines.length + p.inquiries.length + p.publicRecords.length;

/**
 * Reads any accepted report file. The rules parser goes first (free, exact). When it recognises no accounts, or the
 * file is a bureau's own disclosure (AnnualCreditReport.com), and AI reading is on, the AI rewrites the report into the
 * parser's fixed "Label: value" layout and the parser files each value into its field. Scans and photos always go
 * through AI. Anything read by AI has every field flagged for a person to check.
 */
export async function readReportFile(file: ReportFile, payer: Payer, deps: ReadDeps = {}): Promise<ReadResult> {
  const enabled = deps.enabled ?? ocrEnabled;
  if (file.mime === 'text/csv' || /\.csv$/i.test(file.name)) return { parsed: parseTradelineCsv(file.bytes.toString('utf8')), via: 'rules' };

  let text: string;
  if (file.mime === 'text/plain' || file.mime === 'text/html') {
    const raw = file.bytes.toString('utf8');
    text = file.mime === 'text/html' ? htmlToText(raw) : raw;
  } else if (file.mime === 'application/pdf') {
    try {
      text = await pdfToText(file.bytes);
    } catch (e) {
      if (!(e instanceof PdfTextError)) throw e;
      if (!e.scanned || !enabled()) throw new ReportReadError(e.message);
      if (e.pages > MAX_SCAN_PAGES) throw new ReportReadError(`This scan has ${e.pages} pages. Up to ${MAX_SCAN_PAGES} pages can be read at once: split it and upload the parts.`);
      return { parsed: await readWithAi({ bytes: file.bytes, mime: 'application/pdf' }, payer, deps, SCAN_WARNING), via: 'ai_scan' };
    }
  } else if (isScanMime(file.mime)) {
    if (!enabled()) throw new ReportReadError(SCANS_OFF_IMAGE);
    return { parsed: await readWithAi({ bytes: file.bytes, mime: file.mime as ScanMime }, payer, deps, SCAN_WARNING), via: 'ai_scan' };
  } else {
    throw new ReportReadError('Only a PDF, photo, text, HTML or CSV file can be read as a report.');
  }

  // The bureaus' own free-report layouts (Experian, Equifax) have exact readers: free, no AI, fixed fields.
  const bureau = parseBureauLayout(text);
  if (bureau && found(bureau)) return { parsed: bureau, via: 'layout' };

  const rules = parseReportText(text);
  const needsAi = rules.tradelines.length === 0 || BUREAU_DISCLOSURE.test(text.slice(0, 5000));
  if (!needsAi) return { parsed: rules, via: 'rules' };
  if (!enabled()) {
    if (found(rules)) return { parsed: rules, via: 'rules' };
    throw new ReportReadError(LAYOUT_NOT_KNOWN);
  }
  return { parsed: await readWithAi({ text }, payer, deps, AI_READ_WARNING), via: 'ai_text' };
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
