/**
 * The PDF copy of a signed agreement, built from what was stored with the signature: the exact text shown, then the
 * signature block. For the service agreement the signature block sits right under the statement of 15 U.S.C.
 * § 1679d(b)(4), and the Notice of Cancellation follows twice, each copy on its own page (§ 1679e(b): "a form, in
 * duplicate"). The statement and the notice are set in bold, as the statute requires. Pure: no database.
 *
 * A signature staff recorded from paper (recorded_by set) stores the app's text of the document on the day it was
 * recorded, dated with the date written on the paper, not a copy of the paper the client signed. Its PDF says exactly
 * that, in the title and above the text, and gives the date written on the paper; it is never called a signed copy.
 * In a personal workspace the account holder gives their own consent in the app (source 'self'): its PDF says so, with
 * no paper wording.
 *
 * The PDF is drawn with the standard Helvetica font, which has no glyph for some characters (a name such as "Nguyễn
 * Thị Hương", or "→" and "™" in the agency's terms): those print as "?". The stored text is exact either way. When that
 * happens the copy says so at the top, and the fingerprint is always labelled as the SHA-256 of the stored text, never
 * of "the text above".
 */
import { unprintable, type PdfBlock } from '../letters/pdf';
import { dayInZone } from '../util';
import { CROA_CANCEL_STATEMENT, longDay, NOTICE_HEADING } from './croa';
import { consentDoc, isConsentKind, type Block, type SignatureSource } from './disclosures';

export interface SignedConsent {
  kind: string;
  text_shown: string;
  text_sha256: string;
  signed_name: string;
  signed_at: string;
  ip: string | null;
  /** Set when a staff member recorded a signature the client gave on paper. */
  recorded_by: string | null;
  /** For a paper signature, the date written on the paper (YYYY-MM-DD); null on rows recorded before migration 0031 kept it. */
  signed_on?: string | null;
  revoked_at: string | null;
}

const blank: PdfBlock = { text: '' };

/** The stored text back as paragraphs, with the paragraphs the law sets in bold marked again. */
export function storedBlocks(text: string): { title: string; blocks: Block[] } {
  const [title = '', ...paras] = text.split('\n\n');
  const notice = paras.lastIndexOf(NOTICE_HEADING);
  return {
    title,
    blocks: paras.map((t, i) => (t === CROA_CANCEL_STATEMENT || (notice >= 0 && i >= notice) ? { text: t, bold: true } : { text: t })),
  };
}

/** Paragraphs with an empty line between them, the way they read on the page. */
const spaced = (blocks: Block[]): PdfBlock[] => blocks.flatMap((b, i) => (i === 0 ? [b] : [blank, b]));

/**
 * Said first when some characters of a copy cannot be printed in its PDF (they appear as "?"): the text that counts is
 * the stored one, which is exact. `signed`: a copy of a signature, whose fingerprint below is of that stored text.
 */
export const unprintableNote = (signed: boolean) => signed
  ? 'Some characters in this document could not be printed in this PDF and appear as "?". The text stored with the signature is exact and complete: the fingerprint below is the SHA-256 of that stored text.'
  : 'Some characters in this document could not be printed in this PDF and appear as "?". The text on the signing page is exact and complete.';

/** The blocks with the note above when anything in them would print as "?". */
const withPrintNote = (blocks: PdfBlock[], signed: boolean): PdfBlock[] =>
  (blocks.some((b) => unprintable(b.text).length > 0) ? [{ text: unprintableNote(signed) }, blank, ...blocks] : blocks);

/** A reading copy of a document that is not signed yet (the client's PDF to open before signing). */
export function readingCopyBlocks(title: string, blocks: Block[]): PdfBlock[] {
  return withPrintNote([{ text: title }, blank, ...spaced(blocks)], false);
}

const when = (iso: string, tz: string) => `${new Date(iso).toLocaleString('en-US', { timeZone: tz, dateStyle: 'long', timeStyle: 'short' })} (${tz})`;

/**
 * What the stored text of a paper signature is, said above it: the app's text on the recording day, not the paper. A
 * service agreement's date and the last day its Notice of Cancellation states are counted from the date on the paper.
 */
export function paperNote(row: SignedConsent, tz: string, agencyName: string): string {
  const recorded = longDay(dayInZone(tz, new Date(row.signed_at)));
  const paper = !row.signed_on ? ''
    : row.kind === 'croa_contract' ? ` The paper is dated ${longDay(row.signed_on)}: the date of this agreement and the last day to cancel in its Notice of Cancellation are counted from that date.`
      : ` The paper is dated ${longDay(row.signed_on)}.`;
  return `This is not a copy of the paper the client signed. It is the text of this document as it was in the app on ${recorded}, the day ${agencyName} staff recorded the client's paper signature.${paper} The signed paper itself is the record of what the client signed.`;
}

/** How the copy says the signature was given: `source` defaults to paper when a staff member recorded it, else the portal. */
const sourceOf = (row: SignedConsent, source?: SignatureSource): SignatureSource => source ?? (row.recorded_by ? 'paper' : 'portal');

export function signatureBlock(row: SignedConsent, tz: string, agencyName: string, source?: SignatureSource): PdfBlock[] {
  const by = sourceOf(row, source);
  const lines = by === 'paper'
    ? [
      `Signed on paper by: ${row.signed_name}`,
      ...(row.signed_on ? [`Date written on the signed paper: ${longDay(row.signed_on)}`] : []),
      `${agencyName} staff recorded the paper signature on ${when(row.signed_at, tz)}. The text above is the app's text on that day, not a copy of the paper.`,
    ]
    : by === 'self'
      ? [`Given by the account holder, in their own workspace, by typing the name: ${row.signed_name}`, `Date and time: ${when(row.signed_at, tz)}`, `IP address: ${row.ip ?? 'not recorded'}`]
      : [`Signed electronically by typing the name: ${row.signed_name}`, `Date and time: ${when(row.signed_at, tz)}`, `IP address: ${row.ip ?? 'not recorded'}`];
  if (row.kind === 'croa_disclosure') lines.unshift(by === 'paper' ? 'Acknowledgement, signed on paper: I received and read this statement.' : 'Acknowledgement: I received and read this statement.');
  // The SHA-256 is of the text stored with the signature (title and body), which is exact even where the PDF prints "?".
  lines.push(by === 'paper' ? `Fingerprint of the app's stored text (SHA-256): ${row.text_sha256}` : `Fingerprint of the stored text (SHA-256): ${row.text_sha256}`);
  if (row.revoked_at) lines.push(`${row.kind === 'croa_contract' ? 'Cancelled' : 'Withdrawn'} on ${when(row.revoked_at, tz)}.`);
  return [{ text: '________________________________________' }, ...lines.map((text) => ({ text }))];
}

/**
 * Everything the copy of one signed document prints, in order. `source` says how it was given (signatureSource in
 * ./disclosures.ts: the PDF route passes it, since only the agency knows a personal workspace); without it a row a
 * staff member recorded is a paper signature.
 */
export function signedCopyBlocks(row: SignedConsent, tz: string, agencyName: string, source?: SignatureSource): PdfBlock[] {
  const { title, blocks } = storedBlocks(row.text_shown);
  const head: PdfBlock[] = sourceOf(row, source) === 'paper' ? [{ text: paperNote(row, tz, agencyName) }, blank, { text: title }, blank] : [{ text: title }, blank];
  const sig = signatureBlock(row, tz, agencyName, source);
  const notice = row.kind === 'croa_contract' ? blocks.map((b) => b.text).lastIndexOf(NOTICE_HEADING) : -1;
  if (notice < 0) return withPrintNote([...head, ...spaced(blocks), blank, blank, ...sig], true);
  const form = blocks.slice(notice);
  const copy = (n: number): PdfBlock[] => [{ text: `Copy ${n} of 2`, pageBreakBefore: true }, blank, ...spaced(form)];
  return withPrintNote([...head, ...spaced(blocks.slice(0, notice)), blank, ...sig, ...copy(1), ...copy(2)], true);
}

const TITLE_NOTE: Record<SignatureSource, string> = {
  portal: 'signed copy',
  paper: "app's text when the paper signature was recorded, not a copy of the paper",
  self: 'given by the account holder',
};

/**
 * The PDF's title. A portal signature's PDF is a signed copy; a paper signature's is the app's text when the signature
 * was recorded, and is never called a signed copy; a personal workspace's own consent is given by the account holder.
 */
export const copyTitle = (kind: string, source: SignatureSource = 'portal') => `${isConsentKind(kind) ? consentDoc(kind).title : kind} (${TITLE_NOTE[source]})`;
