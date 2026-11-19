import { AI_OFF, notChargedNote, withAiCredits, type AiCharge } from '../ai/credits';
import type { Db } from '../db';
import { getProvider, rewriteSafely, type AiProvider, type Rewritten } from '../ai/provider';

export type LetterSuggestion = { ok: true; text: string; provider: string; cost: number } | { ok: false; message: string; ai: AiCharge };

/**
 * AI wording suggestion for a letter, paid for with the organization's AI credits. Charged once, and only when a
 * rewrite that passed every safety check is returned; otherwise the letter text is left as it is and `message` says why.
 */
export async function suggestLetterWording(
  x: { orgId: string; userId: string; body: string; protectedTerms: string[] }, provider: AiProvider | null = getProvider(),
): Promise<LetterSuggestion> {
  const { result, ai } = await withAiCredits<Rewritten>(
    { orgId: x.orgId, feature: 'letter_suggestion', actorUserId: x.userId },
    (p) => rewriteSafely(x.body, 'Polish the wording of this consumer letter so it is clear, courteous and concise.', p, x.protectedTerms),
    provider);
  if (result.usedAi && ai.status === 'charged') return { ok: true, text: result.text, provider: result.provider, cost: ai.cost };
  const message = ai.status === 'no_provider' ? `${AI_OFF.no_provider} The letter is unchanged.`
    : ai.status === 'no_credits' ? `${AI_OFF.no_credits} The letter is unchanged.`
    : `${result.note ?? 'The AI suggestion was not safe to use, so nothing changed.'} ${notChargedNote(ai)}`;
  return { ok: false, message, ai };
}

export interface StoredSuggestion { body: string; provider: string }
type Tx = <T>(fn: (db: Db) => Promise<T>) => Promise<T>;

/** The suggestion already paid for on this version of the letter, if any. Read under the caller's row-level security. */
export function storedSuggestion(db: Db, letterId: string, version: number): Promise<StoredSuggestion | null> {
  return db.row<StoredSuggestion>('select body, provider from public.letter_suggestions where letter_id = $1 and version = $2', [letterId, version]);
}

/**
 * suggestLetterWording for a saved letter, with the paid result kept on the server: a suggestion already paid for on
 * this version is returned again at no charge (`cost: 0`), and a new one is stored before it is returned, so a lost
 * response or a reload does not lose it. `tx` runs under the caller's own session (ctx.tx).
 */
export async function suggestForLetter(
  x: { orgId: string; userId: string; letterId: string; version: number; body: string; protectedTerms: string[] }, tx: Tx,
  provider: AiProvider | null = getProvider(),
): Promise<LetterSuggestion> {
  const kept = await tx((db) => storedSuggestion(db, x.letterId, x.version));
  if (kept) return { ok: true, text: kept.body, provider: kept.provider, cost: 0 };
  const out = await suggestLetterWording(x, provider);
  if (out.ok) {
    await tx((db) => db.run(
      `insert into public.letter_suggestions (letter_id, version, org_id, body, provider, created_by)
       select l.id, $2, l.org_id, $3, $4, $5 from public.letters l where l.id = $1 on conflict do nothing`,
      [x.letterId, x.version, out.text, out.provider, x.userId]))
      .catch((e) => console.error('[ai-credits] paid letter suggestion could not be stored', x.letterId, (e as Error).message));
  }
  return out;
}
