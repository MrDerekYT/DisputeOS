import { withSystem, type Db } from '../db';
import { getProvider, type AiProvider } from './provider';

/**
 * AI credits. Nothing an LLM produces is free: every AI result that passes the safety checks and is returned costs the
 * organization the credits listed here. This is the only price list — the UI, the charges and the tests all read it.
 *
 * The balance is the sum of public.ai_credit_ledger for the organization (migration 0012). Tenant requests can only
 * read that table, so charges, refunds and grants are written here through the system connection, always for an
 * organization id taken from the signed-in session — never from user input.
 */
export const AI_COSTS = {
  letter_suggestion: 5,
  progress_note: 2,
  guide_answer: 1,
  report_scan: 10,
} as const;
export type AiFeature = keyof typeof AI_COSTS;

export const AI_FEATURE_LABEL: Record<AiFeature, string> = {
  letter_suggestion: 'Letter wording suggestion',
  progress_note: 'Client progress note polish',
  guide_answer: 'Credit guide answer worded by AI',
  report_scan: 'Scanned credit report read by AI',
};

/** Shown to staff wherever AI wording was skipped. Portal clients are never shown these. */
export const AI_OFF = {
  no_provider: 'AI wording is off: no AI provider connected.',
  no_credits: 'AI wording is off: no AI credits left.',
} as const;

export const BUYING_NOT_CONNECTED = 'Buying credits online is not connected yet. Credits are added by the platform operator.';

const BALANCE_SQL = 'select coalesce(sum(delta), 0)::int as balance from public.ai_credit_ledger where org_id = $1';

/** Pass the caller's tenant `db` to read under their row-level security (staff only); omit it for trusted server code. */
export async function getBalance(orgId: string, db?: Db): Promise<number> {
  const read = async (d: Db) => (await d.row<{ balance: number }>(BALANCE_SQL, [orgId]))?.balance ?? 0;
  return db ? read(db) : withSystem(read);
}

export type SpendResult = { ok: true; cost: number; id: number } | { ok: false; reason: 'insufficient' };

/**
 * Takes the feature's cost from the organization's balance, or does nothing when the balance is too low.
 * Race-safe: a per-organization advisory lock makes concurrent spends queue, so each one sees the rows the previous
 * one committed and the balance can never go below zero.
 * The row it writes is a reservation: the caller must settle() it or refund() it. One left with neither (the request
 * died mid-call) is given back by refundUnsettled().
 */
export async function spend(orgId: string, feature: AiFeature, actorUserId: string | null): Promise<SpendResult> {
  const cost = AI_COSTS[feature];
  return withSystem(async (db) => {
    await db.run('select pg_advisory_xact_lock(hashtextextended($1, 12))', [orgId]);
    const r = await db.row<{ id: number }>(
      `insert into public.ai_credit_ledger (org_id, delta, reason, feature, actor_user_id)
       select $1, -$2::int, 'use', $3, $4 where (${BALANCE_SQL}) >= $2::int returning id`,
      [orgId, cost, feature, actorUserId]);
    return r ? { ok: true, cost, id: r.id } : { ok: false, reason: 'insufficient' };
  });
}

/**
 * Gives back what spend() took, for an AI call that failed or whose output was discarded by the safety checks.
 * Pass the spend's id so the refund is tied to its charge: the database then allows only one refund per charge.
 */
export async function refund(orgId: string, feature: AiFeature, actorUserId: string | null, note = 'AI result not used', useId: number | null = null): Promise<void> {
  await withSystem((db) => db.run(
    "insert into public.ai_credit_ledger (org_id, delta, reason, feature, note, actor_user_id, ref_id) values ($1, $2, 'refund', $3, $4, $5, $6)",
    [orgId, AI_COSTS[feature], feature, note.slice(0, 200), actorUserId, useId]));
}

/** Records that the AI result was returned, so the charge stands and is never swept. */
export async function settle(useId: number): Promise<void> {
  await withSystem((db) => db.run(
    `update public.ai_credit_ledger set settled_at = now() where id = $1 and reason = 'use' and settled_at is null
        and not exists (select 1 from public.ai_credit_ledger r where r.ref_id = $1 and r.reason = 'refund')`, [useId]));
}

/** How long a charge may stay without an outcome before it is treated as an interrupted request. Far above the provider timeout. */
export const UNSETTLED_AFTER_MINUTES = 10;

/**
 * Gives back every charge that has no recorded outcome after `olderThanMinutes`: the request was killed between the
 * charge and the AI result (a timeout, a deploy, a crash), or its refund could not be written. Run by the scheduled
 * jobs. Safe to run twice or concurrently: the unique index on ref_id allows one refund per charge.
 */
export async function refundUnsettled(olderThanMinutes: number = UNSETTLED_AFTER_MINUTES, onlyOrgId: string | null = null): Promise<number> {
  return withSystem((db) => db.run(
    `insert into public.ai_credit_ledger (org_id, delta, reason, feature, note, actor_user_id, ref_id)
     select u.org_id, -u.delta, 'refund', u.feature, 'AI request was interrupted', u.actor_user_id, u.id
       from public.ai_credit_ledger u
      where u.reason = 'use' and u.settled_at is null and u.created_at < now() - make_interval(mins => $1::int)
        and ($2::uuid is null or u.org_id = $2)
        and not exists (select 1 from public.ai_credit_ledger r where r.ref_id = u.id and r.reason = 'refund')
     on conflict do nothing`, [olderThanMinutes, onlyOrgId]));
}

export interface AiBill { orgId: string; feature: AiFeature; actorUserId: string | null }
/**
 *   no_provider     no LLM is configured; nothing was called or charged
 *   no_credits      the balance was too low; the LLM was not called
 *   not_called      the work never reached the LLM (nothing for it to do); nothing was charged
 *   refunded        the LLM was called but its result failed or was discarded; the charge was given back
 *   refund_pending  as refunded, but the refund could not be written just now; the scheduled jobs give it back
 *   charged         an AI result was returned and paid for
 */
export type AiChargeStatus = 'no_provider' | 'no_credits' | 'not_called' | 'refunded' | 'refund_pending' | 'charged';
export interface AiCharge { status: AiChargeStatus; cost: number }

/** Shown to staff in place of "no AI credits were used" when a refund could not be written immediately. */
export const AI_REFUND_PENDING = 'The AI credits taken for this attempt could not be returned just now; the next scheduled check returns them.';
/** What staff are told about the charge when no AI result was returned. */
export const notChargedNote = (ai: AiCharge): string => ai.status === 'refund_pending' ? AI_REFUND_PENDING : 'No AI credits were used.';

class NoCredits extends Error { constructor() { super('no AI credits left'); } }

/** Never throws: a refund that cannot be written is retried once, then logged and left to refundUnsettled(). */
async function refundOrLog(bill: AiBill, useId: number, note?: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { await refund(bill.orgId, bill.feature, bill.actorUserId, note, useId); return true; } catch (e) {
      console.error(`[ai-credits] REFUND FAILED (attempt ${attempt}) org=${bill.orgId} use=${useId} feature=${bill.feature}:`, (e as Error).message);
    }
  }
  return false;
}

/**
 * Runs AI-assisted work so that it is paid for exactly when an AI result is returned.
 * `run` receives the provider to use (null = the existing non-AI path) and must report `usedAi`. The credits are taken
 * at the moment the LLM is first called — so two requests cannot both use the last credits — and given back if the
 * call fails, throws, or its output is not used. With no provider or no credits, `run` simply takes its non-AI path.
 * A failing refund never hides the work's own error or result; a request killed mid-call is refunded by refundUnsettled().
 */
export async function withAiCredits<T extends { usedAi: boolean }>(
  bill: AiBill, run: (provider: AiProvider | null) => Promise<T>, provider: AiProvider | null = getProvider(),
): Promise<{ result: T; ai: AiCharge }> {
  const cost = AI_COSTS[bill.feature];
  if (!provider) return { result: await run(null), ai: { status: 'no_provider', cost: 0 } };
  let reserved: Promise<SpendResult> | null = null;
  const metered: AiProvider = {
    name: provider.name,
    async complete(req) {
      reserved ??= spend(bill.orgId, bill.feature, bill.actorUserId);
      if (!(await reserved).ok) throw new NoCredits();
      return provider.complete(req);
    },
  };
  // A spend that itself failed charged nothing, so it counts as "not called" here rather than throwing a second time.
  const outcome = async (): Promise<SpendResult | null> => (reserved ? reserved.catch(() => null) : null);
  let result: T;
  try {
    result = await run(metered);
  } catch (e) {
    const paid = await outcome();
    if (paid?.ok) await refundOrLog(bill, paid.id, 'AI call failed');
    throw e;
  }
  const paid = await outcome();
  if (!paid) return { result, ai: { status: 'not_called', cost: 0 } };
  if (!paid.ok) return { result: result.usedAi ? await run(null) : result, ai: { status: 'no_credits', cost: 0 } };
  if (!result.usedAi) {
    return (await refundOrLog(bill, paid.id)) ? { result, ai: { status: 'refunded', cost: 0 } } : { result, ai: { status: 'refund_pending', cost } };
  }
  // If this write fails the result is still delivered; the sweep then returns the credits, which errs in the customer's favour.
  await settle(paid.id).catch((e) => console.error(`[ai-credits] could not settle use=${paid.id} org=${bill.orgId}:`, (e as Error).message));
  return { result, ai: { status: 'charged', cost } };
}

/**
 * The polish button on the client page. It stays on the page whenever a provider is connected, whatever the balance:
 * the polished text lives in that component, and the press that spends the last credits refreshes the page — hiding
 * the button then would discard the text that was just paid for. With too few credits the action itself refuses.
 */
export function polishOffer(aiActive: boolean, credits: number): { button: boolean; note: string } {
  if (!aiActive) return { button: false, note: AI_OFF.no_provider };
  const left = `AI credits: ${credits}.`;
  return credits < AI_COSTS.progress_note
    ? { button: true, note: `${left} ${AI_OFF.no_credits}` }
    : { button: true, note: `${left} Charged only when polished wording is returned; the numbers in the note cannot change.` };
}

/** AI-worded guide answers one portal client may use, on the agency's credits, in any 24 hours. Beyond it they get the vetted answer. */
export const PORTAL_GUIDE_DAILY_CAP = 10;

/**
 * Whether a portal client's guide question may use the agency's AI credits: only when the agency switched it on
 * (settings.portal_ai_guide, off by default) and this client is under the daily cap. Refunded attempts do not count.
 */
export async function portalGuideAiAllowed(orgId: string, clientUserId: string): Promise<boolean> {
  const r = await withSystem((db) => db.row<{ enabled: boolean; used: number }>(
    `select coalesce((select settings->>'portal_ai_guide' = 'true' from public.organizations where id = $1), false) as enabled,
            coalesce((select -sum(delta) from public.ai_credit_ledger
                       where org_id = $1 and actor_user_id = $2 and feature = 'guide_answer' and reason in ('use', 'refund')
                         and created_at > now() - interval '24 hours'), 0)::int as used`, [orgId, clientUserId]));
  return !!r?.enabled && r.used < PORTAL_GUIDE_DAILY_CAP * AI_COSTS.guide_answer;
}

export interface LedgerRow { id: number; delta: number; reason: string; feature: string | null; note: string | null; actor: string | null; created_at: string }

/** Most recent ledger rows, read under the caller's row-level security (staff of the organization only). */
export function recentLedger(db: Db, orgId: string, limit = 20): Promise<LedgerRow[]> {
  return db.rows<LedgerRow>(
    `select l.id, l.delta, l.reason, l.feature, l.note, u.full_name as actor, l.created_at
       from public.ai_credit_ledger l left join public.users u on u.id = l.actor_user_id
      where l.org_id = $1 order by l.id desc limit $2`, [orgId, limit]);
}

export function ledgerLabel(r: Pick<LedgerRow, 'reason' | 'feature'>): string {
  const what = r.feature && r.feature in AI_FEATURE_LABEL ? AI_FEATURE_LABEL[r.feature as AiFeature] : r.feature;
  switch (r.reason) {
    case 'use': return what ?? 'AI use';
    case 'refund': return `Refund${what ? `: ${what}` : ''} (AI result not used)`;
    case 'grant': return 'Credits added by the platform operator';
    case 'purchase': return 'Credits purchased';
    default: return 'Adjustment';
  }
}
