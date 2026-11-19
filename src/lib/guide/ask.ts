/**
 * Builds one credit-guide reply:
 *   1. the knowledge-base answer (optionally re-phrased by an AI provider, see ./llm.ts);
 *   2. "for you right now" — steps from the asker's own records, loaded by the caller under row-level security;
 *   3. links to existing screens.
 * The guide explains and points to the right screen. It never performs an account action and stores nothing.
 */
import { AI_OFF, portalGuideAiAllowed, withAiCredits } from '../ai/credits';
import type { AiProvider } from '../ai/provider';
import { getProvider } from '../ai/provider';
import type { Lang } from '../portal-i18n';
import { resolveLink, type GuideAudience, type GuideEntry } from './knowledge';
import { findGuideClaims, phraseGuideAnswer } from './llm';
import { answerFromKnowledge, fallbackText, MAX_QUESTION_CHARS } from './match';
import { genericStepLabels, type GuideStep, type PersonalSteps } from './steps';

export interface GuideTopic { id: string; question: string }
export interface GuideLinkOut { label: string; href: string }

export interface GuideAnswer {
  ok: true;
  answer: string;
  /** The knowledge-base question that was answered; null when the guide was not sure. */
  topic: string | null;
  /** Other questions the person can tap: related topics, or the starter list when the guide was not sure. */
  topics: GuideTopic[];
  steps: GuideStep[];
  links: GuideLinkOut[];
  /** How the answer text was produced. Shown to staff only. */
  mode: 'knowledge' | 'ai' | 'unsure';
  note?: string;
}
export type GuideReply = GuideAnswer | { ok: false; error: string };

export function validQuestion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const q = raw.replace(/\s+/g, ' ').trim();
  return q.length >= 1 && q.length <= MAX_QUESTION_CHARS ? q : null;
}

const topic = (e: GuideEntry, lang: Lang): GuideTopic => ({ id: e.id, question: e.question[lang] });

export async function buildGuideReply(
  x: { question: string; lang: Lang; audience: GuideAudience; personal?: PersonalSteps },
  provider: AiProvider | null = getProvider(),
): Promise<GuideAnswer> {
  const { lang, audience } = x;
  const steps = x.personal?.steps ?? [];
  const match = answerFromKnowledge(x.question, lang, audience);
  const links: GuideLinkOut[] = [];
  const add = (l: GuideLinkOut | null) => { if (l && !links.some((k) => k.href === l.href)) links.push(l); };

  if (!match.entry) {
    if (audience === 'portal') add({ label: lang === 'es' ? 'Escribir a su especialista' : 'Message your specialist', href: '/portal/messages' });
    return { ok: true, answer: fallbackText(audience, lang), topic: null, topics: match.related.map((e) => topic(e, lang)), steps, links, mode: 'unsure' };
  }

  const entry = match.entry;
  for (const l of entry.links ?? []) add(resolveLink(l, audience, lang));
  // The written entry is the answer of record. It is checked here as well as in the test suite: a prohibited claim
  // in the knowledge base must never reach a person, so an entry that fails is replaced by the "not sure" answer.
  if (findGuideClaims(entry.answer[lang]).length) {
    return { ok: true, answer: fallbackText(audience, lang), topic: null, topics: [], steps, links: [], mode: 'unsure' };
  }
  const phrased = await phraseGuideAnswer(
    { question: x.question, lang, entries: [entry, ...match.related], stepLabels: genericStepLabels(steps), redact: x.personal?.redact },
    entry.answer[lang], provider);
  return {
    ok: true, answer: phrased.text, topic: entry.question[lang], topics: match.related.map((e) => topic(e, lang)), steps, links,
    mode: phrased.usedAi ? 'ai' : 'knowledge', note: phrased.note,
  };
}

/**
 * buildGuideReply paid for with AI credits — the version every signed-in caller uses. One credit is charged to the
 * organization only when an AI-worded answer is returned; with no provider or no credits the vetted answer is returned
 * exactly as before. A portal client asks on the agency's credits (the agency is the customer) and is told nothing about
 * them; staff get a short line saying why AI wording was skipped.
 */
export async function buildPaidGuideReply(
  x: Parameters<typeof buildGuideReply>[0], bill: { orgId: string; userId: string }, provider: AiProvider | null = getProvider(),
): Promise<GuideAnswer> {
  const { result, ai } = await withAiCredits(
    { orgId: bill.orgId, feature: 'guide_answer', actorUserId: bill.userId },
    async (p) => { const reply = await buildGuideReply(x, p); return { reply, usedAi: reply.mode === 'ai' }; },
    provider);
  const reply = result.reply;
  if (ai.status === 'no_credits') return { ...reply, note: x.audience === 'app' ? AI_OFF.no_credits : undefined };
  if (ai.status === 'no_provider' && x.audience === 'app' && reply.mode === 'knowledge') return { ...reply, note: AI_OFF.no_provider };
  return reply;
}

/**
 * The portal client's guide reply. The client is spending the agency's balance, so AI wording is used only when the
 * agency switched it on and this client is under the daily cap (portalGuideAiAllowed); otherwise the model is not
 * called and the vetted answer is returned free, with nothing said about credits.
 */
export async function buildPortalGuideReply(
  x: Omit<Parameters<typeof buildGuideReply>[0], 'audience'>, bill: { orgId: string; userId: string }, provider: AiProvider | null = getProvider(),
): Promise<GuideAnswer> {
  const allowed = provider !== null && await portalGuideAiAllowed(bill.orgId, bill.userId);
  return buildPaidGuideReply({ ...x, audience: 'portal' }, bill, allowed ? provider : null);
}
