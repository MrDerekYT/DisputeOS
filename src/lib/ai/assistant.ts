import { assertNoBlockedClaims } from '../compliance/claims';
import type { Outcome } from '../disputes/workflow';
import { rewriteSafely, type Rewritten } from './provider';

/**
 * The AI assistant's deterministic core. Every capability here works with no LLM at all; an LLM (if configured) may
 * only polish the wording through rewriteSafely(), which rejects anything that drops or adds a fact.
 * Output is always a DRAFT for a person to review and edit.
 */

// ---- Reading a bureau/furnisher reply (English + Spanish). A person always confirms the result. -----------------------
const NEGATED_DELETE = /\b(not|cannot|can't|unable to|won't|will not|did not|didn't)\b[^.]{0,30}\b(deleted|removed|remove|delete)\b|\bno\s+(se\s+)?(elimin|borr)/i;
const DELETED = /\b(deleted|removed|no longer (appear|report)|has been removed|will be removed)\b|\belimin(ad|ó|amos)|\bborrad/i;
const VERIFIED = /\b(verified|confirmed|accurate as reported|will remain|remains?|reported correctly)\b|\bverificad|\bse mantiene|\bcorrect[oa]\b/i;
const UPDATED = /\b(updated|modified|corrected|changed|revised|adjusted)\b|\bactualiz|\bmodific|\bcorreg/i;
const INSUFFICIENT = /\b(frivolous|irrelevant|insufficient information|unable to (locate|identify)|could not (locate|identify)|additional information is needed)\b/i;

export interface ResponseReading { outcome: Outcome | null; matched: string | null; needsReview: boolean; summary: string }

export function classifyResponse(text: string): ResponseReading {
  const t = text.trim();
  if (t.length < 8) return { outcome: null, matched: null, needsReview: true, summary: 'The reply is too short to interpret. Read it and record the outcome yourself.' };
  const hit = (re: RegExp) => re.exec(t)?.[0] ?? null;
  let outcome: Outcome | null = null;
  let m: string | null = null;
  if ((m = hit(NEGATED_DELETE))) outcome = 'verified';
  else if ((m = hit(DELETED))) outcome = 'deleted';
  else if ((m = hit(UPDATED))) outcome = 'updated';
  else if ((m = hit(VERIFIED))) outcome = 'verified';
  else if ((m = hit(INSUFFICIENT))) outcome = 'unresolved';
  const sentences = t.split(/(?<=[.!?])\s+/).filter((s) => s.length > 10);
  const key = m ? sentences.find((s) => s.toLowerCase().includes(m!.toLowerCase())) : undefined;
  const summary = outcome
    ? `This reply appears to say the item was ${outcome === 'deleted' ? 'removed' : outcome === 'updated' ? 'updated' : outcome === 'verified' ? 'verified as reported' : 'not resolved'}${key ? `: “${key.slice(0, 200)}”` : ''}. Confirm by reading the full reply.`
    : 'No clear outcome was found. Read the reply and record the outcome yourself.';
  return { outcome, matched: m, needsReview: true, summary };
}

// ---- Client progress note ------------------------------------------------------------------------------------------------
export interface ProgressStats { firstName: string; total: number; deleted: number; updated: number; verified: number; waiting: number; draft: number; language: 'en' | 'es' }

export function progressSummary(s: ProgressStats): string {
  const changed = s.deleted + s.updated;
  const es = s.language === 'es';
  const parts = es
    ? [
      `Hola ${s.firstName}, este es el estado de su caso.`,
      s.total === 0 ? 'Todavía no hemos enviado disputas; estamos revisando sus informes.' : `De ${s.total} cuenta${s.total === 1 ? '' : 's'} en disputa, ${changed} ${changed === 1 ? 'cambió' : 'cambiaron'} (${s.deleted} eliminada${s.deleted === 1 ? '' : 's'}, ${s.updated} corregida${s.updated === 1 ? '' : 's'}), ${s.verified} se verificaron tal como estaban y ${s.waiting} siguen en revisión.`,
      'Los resultados varían: cada decisión la toman las agencias y las empresas que reportan, no nosotros. Le avisaremos de cada respuesta.',
    ]
    : [
      `Hi ${s.firstName}, here is where your case stands.`,
      s.total === 0 ? 'We have not sent any disputes yet; we are reviewing your reports.' : `Of ${s.total} disputed item${s.total === 1 ? '' : 's'}, ${changed} changed (${s.deleted} removed, ${s.updated} corrected), ${s.verified} ${s.verified === 1 ? 'was' : 'were'} verified as reported, and ${s.waiting} ${s.waiting === 1 ? 'is' : 'are'} still under review.`,
      'Results vary: every decision is made by the credit bureaus and the companies that report to them, not by us. We will let you know about each response.',
    ];
  return assertNoBlockedClaims(parts.join(' '));
}

export async function polishedProgress(s: ProgressStats): Promise<Rewritten> {
  return rewriteSafely(progressSummary(s), `Make this client progress note warm and easy to read in ${s.language === 'es' ? 'Spanish' : 'English'}.`);
}
