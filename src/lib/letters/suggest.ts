import { AI_OFF, notChargedNote, refund, withAiCredits, type AiCharge } from '../ai/credits';
import type { Db } from '../db';
import { getProvider, type AiProvider, type Rewritten } from '../ai/provider';
import { tailorIssue, tailorSafely, type TailorInput } from './tailor';

export type LetterSuggestion = { ok: true; text: string; provider: string; cost: number } | { ok: false; message: string; ai: AiCharge };

/**
 * AI wording suggestion for a letter, paid for with the organization's AI credits. Charged once, and only when a
 * rewrite that passed every safety check is returned; otherwise the letter text is left as it is and `message` says why.
 * The rewrite is the tailoring in ./tailor.ts: the connective wording only, in the voice picked by `seed`, with every
 * fact locked and the result checked again before it counts.
 */
export async function suggestLetterWording(
  x: { orgId: string; userId: string; body: string } & TailorInput, provider: AiProvider | null = getProvider(),
): Promise<LetterSuggestion> {
  const { result, ai } = await withAiCredits<Rewritten>(
    { orgId: x.orgId, feature: 'letter_suggestion', actorUserId: x.userId },
    (p) => tailorSafely(x.body, { protectedTerms: x.protectedTerms, seed: x.seed, specificity: x.specificity }, p),
    provider);
  if (result.usedAi && ai.status === 'charged') return { ok: true, text: result.text, provider: result.provider, cost: ai.cost };
  const message = ai.status === 'no_provider' ? `${AI_OFF.no_provider} The letter is unchanged.`
    : ai.status === 'no_credits' ? `${AI_OFF.no_credits} The letter is unchanged.`
    : `${result.note ?? 'The AI suggestion was not safe to use, so nothing changed.'} ${notChargedNote(ai)}`;
  return { ok: false, message, ai };
}

export interface StoredSuggestion { body: string; provider: string }
/** Said when the suggestion kept for a letter version no longer passes the checks. One is kept per version, so a new version is what frees the slot. */
export const STALE_SUGGESTION = 'The suggestion kept for this version of the letter no longer passes the wording checks, so it is not offered. Save a change to the letter to ask for a new one.';
/** Runs under the caller's own session (ctx.tx), so row-level security applies to every read and write. */
export type Tx = <T>(fn: (db: Db) => Promise<T>) => Promise<T>;

/** The suggestion already paid for on this version of the letter, if any. Read under the caller's row-level security. */
export function storedSuggestion(db: Db, letterId: string, version: number): Promise<StoredSuggestion | null> {
  return db.row<StoredSuggestion>('select body, provider from public.letter_suggestions where letter_id = $1 and version = $2', [letterId, version]);
}

/**
 * suggestLetterWording for a saved letter, with the paid result kept on the server: a suggestion already paid for on
 * this version is returned again at no charge (`cost: 0`), and a new one is stored before it is returned, so a lost
 * response or a reload does not lose it. One letter version is charged once: when two requests for the same version
 * overlap, the one that finds a suggestion already stored gets its credits back and returns the stored one. `tx` runs
 * under the caller's own session (ctx.tx).
 */
export async function suggestForLetter(
  x: { orgId: string; userId: string; letterId: string; version: number; body: string } & TailorInput, tx: Tx,
  provider: AiProvider | null = getProvider(),
): Promise<LetterSuggestion> {
  const kept = await tx((db) => storedSuggestion(db, x.letterId, x.version));
  if (kept) {
    // Offered again only while it still passes the checks as they are today (it may have been made under earlier rules).
    if (!tailorIssue(x.body, kept.body, x)) return { ok: true, text: kept.body, provider: kept.provider, cost: 0 };
    return { ok: false, message: `${STALE_SUGGESTION} No AI credits were used.`, ai: { status: 'not_called', cost: 0 } };
  }
  const out = await suggestLetterWording(x, provider);
  if (!out.ok) return out;
  // Nothing is written when another request stored a suggestion for this version first: that one is read back instead.
  const first = await tx(async (db) => {
    const wrote = await db.run(
      `insert into public.letter_suggestions (letter_id, version, org_id, body, provider, created_by)
       select l.id, $2, l.org_id, $3, $4, $5 from public.letters l where l.id = $1 on conflict do nothing`,
      [x.letterId, x.version, out.text, out.provider, x.userId]);
    return wrote ? null : storedSuggestion(db, x.letterId, x.version);
  }).catch((e) => { console.error('[ai-credits] paid letter suggestion could not be stored', x.letterId, (e as Error).message); return null; });
  // Like any stored suggestion, the one read back is offered only while it passes the checks.
  if (!first || tailorIssue(x.body, first.body, x)) return out;
  // The version already has its paid suggestion, so this request's charge is given back (tried twice). If the refund
  // cannot be written, the cost is still reported, so staff are never told credits were returned when they were not.
  let refunded = false;
  for (let attempt = 1; attempt <= 2 && !refunded; attempt++) {
    refunded = await refund(x.orgId, 'letter_suggestion', x.userId, 'This letter version already had a suggestion').then(() => true, (e) => {
      console.error(`[ai-credits] REFUND FAILED (attempt ${attempt}) org=${x.orgId} letter=${x.letterId} version=${x.version}:`, (e as Error).message);
      return false;
    });
  }
  return { ok: true, text: first.body, provider: first.provider, cost: refunded ? 0 : out.cost };
}
