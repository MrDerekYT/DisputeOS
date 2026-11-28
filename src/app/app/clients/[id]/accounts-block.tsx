import { ChevronDown } from 'lucide-react';
import { ActionForm, Select, SubmitButton } from '@/components/forms';
import { KindBadge } from '@/components/kind-badge';
import { Section } from '@/components/ui';
import { AI_COSTS, getBalance } from '@/lib/ai/credits';
import { providerStatus } from '@/lib/ai/provider';
import type { Ctx } from '@/lib/auth/context';
import { accountLabel, groupLabel, isBadKind, KIND_META, labelBasis, labelOrder, STAFF_KINDS, storedLabel, TAG_LABEL, type AccountLabel } from '@/lib/credit/account-kind';
import { AI_LABEL_LIMIT } from '@/lib/credit/account-labels';
import { groupAccounts, type AnalysisTradeline } from '@/lib/reports/analysis';
import { loadAnalysisInput } from '@/lib/reports/service';
import { BUREAU_LABEL, BUREAUS, money } from '@/lib/util';
import { labelAccountsAction, setAccountKindAction } from '../account-label-actions';

const STAFF_OPTIONS = STAFF_KINDS.map((k) => ({ value: k, label: KIND_META[k].label }));

interface Row { key: string; name: string; bureaus: string; balance: number | null; label: AccountLabel; lines: AnalysisTradeline[]; each: { bureau: string; label: AccountLabel }[]; differs: boolean }

/**
 * Every account on the newest approved report of each bureau, one row per account however many bureaus report it,
 * labelled from the report's own words (src/lib/credit/account-kind.ts): what is negative is red and comes first, what
 * the words do not settle is "Not labelled" and can be sent to AI or labelled by a person, and the rest is folded away.
 * A label is a reading of the report, not a judgement that the report is right, and nothing here is about a score.
 */
export async function AccountsBlock({ ctx, clientId }: { ctx: Ctx; clientId: string }) {
  const d = await ctx.tx(async (db) => ({ input: await loadAnalysisInput(db, clientId), credits: await getBalance(ctx.orgId, db) }));
  if (!d.input.tradelines.length) return null;
  const canWrite = ctx.can('reports:write');
  const ai = providerStatus();

  const rows: Row[] = groupAccounts(d.input.tradelines).map((g) => {
    const lines = BUREAUS.flatMap((b) => (g.byBureau[b] ? [g.byBureau[b]!] : []));
    const gl = groupLabel(lines);
    const last4 = lines.find((t) => t.account_last4)?.account_last4;
    return {
      key: g.key, name: `${g.creditor}${last4 ? ` ••${last4}` : ''}`, bureaus: lines.map((t) => BUREAU_LABEL[t.bureau]).join(', '),
      balance: gl.line.balance_cents == null ? null : Number(gl.line.balance_cents), label: gl.label, lines,
      each: gl.each.map((e) => ({ bureau: BUREAU_LABEL[e.line.bureau], label: e.label })), differs: gl.differs,
    };
  }).sort((a, b) => labelOrder(a.label.kind) - labelOrder(b.label.kind) || a.name.localeCompare(b.name));

  const bad = rows.filter((r) => isBadKind(r.label.kind));
  const open = rows.filter((r) => r.label.kind === 'unknown');
  const good = rows.filter((r) => !isBadKind(r.label.kind) && r.label.kind !== 'unknown');
  // What AI may still be asked about: entries the rules could not label, that have no label of their own yet.
  const askable = rows.filter((r) => r.lines.some((t) => t.kind_label == null && accountLabel(t).kind === 'unknown'));

  return (
    <Section plain id="accounts" title="Accounts, good and bad"
      hint="Every account on the latest approved reports, labelled from the words each bureau reports. Change any label that is wrong: a label you choose is kept for this account on later reports when they show its account number or open date. A label is a reading of the report, not a judgement that it is right.">
      {/* A count is in colour only when there is something to count: "0 negative" is good news, not a warning. */}
      <p className="text-sm">
        <span className={bad.length ? 'font-semibold text-bad' : 'font-semibold'}>{bad.length} negative</span>
        {open.length > 0 && <> · <span className="font-semibold">{open.length} not labelled</span></>}
        {' · '}<span className={good.length ? 'font-semibold text-ok' : 'font-semibold'}>{good.length} with nothing negative</span>
      </p>

      {askable.length > 0 && canWrite && (
        ai.active ? (
          <ActionForm action={labelAccountsAction} className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <input type="hidden" name="clientId" value={clientId} />
            <SubmitButton variant="secondary" pendingText="Asking AI…">Ask AI about {askable.length === 1 ? 'the account' : `the ${askable.length} accounts`} without a label</SubmitButton>
            <p className="text-[0.8125rem] text-muted">
              {AI_COSTS.account_label} AI credits, charged only when AI has something to suggest (up to {AI_LABEL_LIMIT} at a time). AI credits left: {d.credits}. It sees the account’s own words only, without amounts or names. Each suggestion shows the words it rests on and does nothing until you confirm it.
            </p>
          </ActionForm>
        ) : (
          <p className="mt-3 text-[0.8125rem] text-muted">AI is not connected, so the accounts without a label wait for a person. Choose their labels below.</p>
        )
      )}

      {bad.length + open.length > 0 && (
        <ul className="mt-3 divide-y divide-line/70 rounded-xl border border-line px-3.5">
          {[...bad, ...open].map((r) => <AccountRow key={r.key} r={r} clientId={clientId} canWrite={canWrite} />)}
        </ul>
      )}
      {good.length > 0 && (
        <details className="group/good mt-3">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md text-[0.8125rem] font-semibold text-brand-strong [&::-webkit-details-marker]:hidden">
            {good.length} account{good.length === 1 ? '' : 's'} with nothing negative <ChevronDown size={15} aria-hidden className="transition-transform group-open/good:rotate-180" />
          </summary>
          <ul className="mt-2 divide-y divide-line/70 rounded-xl border border-line px-3.5">
            {good.map((r) => <AccountRow key={r.key} r={r} clientId={clientId} canWrite={canWrite} />)}
          </ul>
        </details>
      )}
    </Section>
  );
}

function AccountRow({ r, clientId, canWrite }: { r: Row; clientId: string; canWrite: boolean }) {
  const staff = r.lines.map((t) => storedLabel(t.kind_label)).find((s) => s?.by === 'staff');
  const tags = [...new Set(r.each.flatMap((e) => e.label.tags))];
  // An AI suggestion (or an AI hint of good standing) is offered as the choice, so one Save confirms it.
  const suggested = r.label.by === 'ai' ? r.label.kind : r.label.aiHint?.kind;
  const preset = staff?.kind ?? (suggested && (STAFF_KINDS as readonly string[]).includes(suggested) ? suggested : '');
  const ask = r.label.by === 'ai' || r.label.aiHint ? 'Confirm or change' : r.label.kind === 'unknown' ? 'Label it' : 'Change label';
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5">
        <div className="min-w-0">
          <div className="font-medium [overflow-wrap:anywhere]">{r.name}</div>
          <div className="text-[0.8125rem] text-muted">
            {r.bureaus}{r.balance != null ? ` · balance ${money(r.balance)}` : ''}{tags.length ? ` · ${tags.map((t) => TAG_LABEL[t]).join(' · ')}` : ''}
          </div>
          <div className="mt-0.5 text-[0.8125rem] text-muted [overflow-wrap:anywhere]">{labelBasis(r.label)}</div>
          {r.differs && <div className="mt-0.5 text-[0.8125rem] text-muted">Each bureau: {r.each.map((e) => `${e.bureau}: ${KIND_META[e.label.kind].label.toLowerCase()}`).join(' · ')}</div>}
        </div>
        <KindBadge label={r.label} />
      </div>
      {canWrite && (
        <details className="group/change mt-1.5">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md text-[0.8125rem] font-semibold text-brand-strong [&::-webkit-details-marker]:hidden">
            {ask} <ChevronDown size={14} aria-hidden className="transition-transform group-open/change:rotate-180" />
          </summary>
          <ActionForm action={setAccountKindAction} className="mt-2 flex flex-wrap items-end gap-2">
            <input type="hidden" name="clientId" value={clientId} />
            {r.lines.map((t) => <input key={t.id} type="hidden" name="ids" value={t.id} />)}
            <Select label="This account is" name="kind" defaultValue={preset} placeholder="As the report’s words say" options={STAFF_OPTIONS} className="min-w-[14rem]" />
            <SubmitButton variant="secondary" className="btn-sm">Save label</SubmitButton>
          </ActionForm>
        </details>
      )}
    </li>
  );
}
