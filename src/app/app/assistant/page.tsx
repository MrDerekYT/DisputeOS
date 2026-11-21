import Link from 'next/link';
import type { Metadata } from 'next';
import { Ban, CheckCircle2, ChevronDown, ChevronRight, FileSearch, MessageSquareText, ScanSearch, Scale } from 'lucide-react';
import { ActionForm, SubmitButton, TextArea } from '@/components/forms';
import { AiTag, Avatar, Notice, PageHeader, Section } from '@/components/ui';
import { AI_COSTS, AI_FEATURE_LABEL, AI_OFF, BUYING_NOT_CONNECTED, getBalance, ledgerLabel, PORTAL_GUIDE_DAILY_CAP, recentLedger, type AiFeature } from '@/lib/ai/credits';
import { providerStatus } from '@/lib/ai/provider';
import { requireStaff } from '@/lib/auth/context';
import { fmtDate } from '@/lib/util';
import { analyzeReplyAction } from '../disputes/actions';
import { setPortalGuideAiAction } from '../settings/actions';
import { autoTailorOn } from '@/lib/letters/tailor-load';
import { LetterTailoringSetting } from './letter-tailoring';

export const metadata: Metadata = { title: 'AI assistant' };

const CAN = [
  'Compare Experian, Equifax and TransUnion and list differences worth checking — with the exact values behind each one.',
  'Spot items whose reported dates suggest they may be past the reporting period, duplicates, and personal information that doesn’t match.',
  'Draft the reason for a dispute from the report data, phrased as a request to verify.',
  'Read a pasted bureau reply and suggest whether it says deleted, updated or verified.',
  'Write a plain-language progress note for the client.',
  'Suggest next steps and warn when another round would repeat a dispute without new information.',
];
const CANNOT = [
  'Invent facts, balances, dates or payment histories — it only works from what is in the client’s reports.',
  'Claim identity theft or fraud. It asks for the client’s account and, where relevant, an identity theft report.',
  'Label an item “inaccurate” just because bureaus differ. Differences are flagged to investigate.',
  'Promise a score change or a deletion, or send anything. Every output is a draft that a person reviews, edits and approves.',
];

export default async function AssistantPage() {
  const ctx = await requireStaff();
  const ai = providerStatus();
  const clients = await ctx.tx((db) => db.rows<{ id: string; full_name: string; approved: number; findings: number }>(
    `select c.id, c.full_name, (select count(*)::int from public.credit_reports r where r.client_id = c.id and r.status = 'approved') as approved,
            (select count(*)::int from public.findings f where f.client_id = c.id and f.status = 'suggested') as findings
       from public.clients c where c.status <> 'cancelled' order by c.last_activity_at desc limit 12`));
  const manage = ctx.can('settings:manage');
  const { balance, ledger, portalAi, autoTailor } = await ctx.tx(async (db) => ({
    balance: await getBalance(ctx.orgId, db), ledger: manage ? await recentLedger(db, ctx.orgId, 20) : [], autoTailor: await autoTailorOn(db, ctx.orgId),
    portalAi: (await db.row<{ on: boolean | null }>("select settings->>'portal_ai_guide' = 'true' as on from public.organizations where id = $1", [ctx.orgId]))?.on === true,
  }));
  const prices = Object.entries(AI_COSTS) as [AiFeature, number][];
  const cheapest = Math.min(...prices.map(([, n]) => n));
  return (
    <>
      <PageHeader title="AI assistant" subtitle="Analysis and drafting help that shows its work — and never acts on its own." />
      <div className="mb-6"><Notice tone={ai.active ? 'ok' : 'info'} title={`Engine: ${ai.provider}`}>{ai.note}</Notice></div>

      <div className="mb-6">
        <Section id="ai-credits" title="AI credits" hint="AI wording is paid for with credits. Everything else on this page works without them.">
          <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
            <div>
              <div className="display text-5xl tabular-nums">{balance}</div>
              <div className="mt-1 text-sm text-muted">credits available</div>
              {!ai.active ? <p className="mt-2 text-sm text-muted">{AI_OFF.no_provider}</p> : balance < cheapest ? <p className="mt-2 text-sm text-muted">{AI_OFF.no_credits}</p> : null}
            </div>
            <div>
              <ul className="divide-y divide-line/70 text-sm">{prices.map(([k, n]) => (
                <li key={k} className="flex justify-between gap-3 py-1.5"><span>{AI_FEATURE_LABEL[k]}</span><span className="tabular-nums text-muted">{n} credit{n === 1 ? '' : 's'}</span></li>))}</ul>
              <p className="mt-2 text-xs text-muted">Credits are taken only when AI wording is returned. {BUYING_NOT_CONNECTED}</p>
              <details className="group mt-2">
                <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md text-xs font-semibold text-brand-strong [&::-webkit-details-marker]:hidden">When credits are given back <ChevronDown size={14} aria-hidden className="transition-transform group-open:rotate-180" /></summary>
                <p className="mt-1.5 text-xs text-muted">If the AI fails, or its wording is discarded by the safety checks, the credits are given back and the standard wording is used. If a request is cut off before it finishes, its credits are given back by the next scheduled check.</p>
              </details>
            </div>
          </div>
          {manage && (
            <div className="mt-5 border-t border-line pt-4">
              <h3 className="mb-1 text-sm font-semibold">Client portal guide: {portalAi ? 'AI wording is on' : 'AI wording is off'}</h3>
              <p className="mb-2 text-sm text-muted">{portalAi
                ? `Your clients’ guide questions use this workspace’s credits: ${AI_COSTS.guide_answer} per AI-worded answer, at most ${PORTAL_GUIDE_DAILY_CAP} per client in 24 hours. After that, and with no credits, they get the standard written answer.`
                : 'Your clients get the standard written answer from the knowledge base, which costs nothing. Turn this on to let their questions use this workspace’s credits.'}</p>
              <form action={setPortalGuideAiAction}><input type="hidden" name="on" value={portalAi ? 'false' : 'true'} />
                <button type="submit" className="btn-secondary btn-sm">{portalAi ? 'Turn off AI wording in the portal' : `Turn on (up to ${PORTAL_GUIDE_DAILY_CAP * AI_COSTS.guide_answer} credits per client in 24 hours)`}</button></form>
            </div>)}
          {manage && <LetterTailoringSetting on={autoTailor} />}
          {manage && (
            <div className="mt-5 border-t border-line pt-4">
              <h3 className="mb-2 text-sm font-semibold">Last 20 entries</h3>
              {ledger.length === 0 ? <p className="text-sm text-muted">No credits have been added or used yet.</p> : (
                // One entry per row: date and amount first, then what it was, then who. It reads the same on a phone as on a desk.
                <ul className="divide-y divide-line/70 text-sm">{ledger.map((r) => {
                  const who = r.actor ?? (r.reason === 'grant' ? 'Platform operator' : null);
                  return (
                    <li key={r.id} className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[7.5rem_1fr_auto]">
                      <span className="whitespace-nowrap text-muted">{fmtDate(r.created_at)}</span>
                      <span className={`text-right font-semibold tabular-nums sm:order-last ${r.delta > 0 ? 'text-ok' : ''}`}>{r.delta > 0 ? `+${r.delta}` : r.delta}<span className="sr-only"> credits</span></span>
                      <span className="col-span-2 min-w-0 sm:col-span-1">{ledgerLabel(r)}{r.note && r.reason !== 'refund' ? <span className="text-muted"> · {r.note}</span> : null}{who && <span className="text-muted"> · {who}</span>}</span>
                    </li>);
                })}</ul>)}
            </div>)}
        </Section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Analyze a client’s reports" hint="Open the three-bureau comparison and review findings." actions={<ScanSearch size={18} aria-hidden className="text-muted max-sm:hidden" />}>
          {clients.length === 0 ? <p className="text-sm text-muted">Add a client and upload reports first.</p> : (
            <ul className="-mx-2 divide-y divide-line/70">{clients.map((c) => (
              <li key={c.id}><Link href={c.approved ? `/app/clients/${c.id}/compare` : `/app/clients/${c.id}?tab=reports`} className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-raised">
                <Avatar name={c.full_name} size={30} /><span className="flex-1 text-sm font-medium">{c.full_name}</span>
                <span className="text-xs text-muted">{c.approved ? `${c.findings} to review` : 'No approved report'}</span></Link></li>))}</ul>)}
        </Section>

        <Section title="Read a bureau reply" hint="Paste the text. You choose the outcome — this only suggests." actions={<FileSearch size={18} aria-hidden className="text-muted max-sm:hidden" />}>
          <ActionForm action={analyzeReplyAction} className="space-y-3">
            <TextArea label="Reply text" name="reply" rows={6} required placeholder="Paste the bureau or creditor response…" />
            <SubmitButton variant="secondary" pendingText="Reading…">Suggest an outcome</SubmitButton>
          </ActionForm>
        </Section>

        <Section title="Draft a client update" hint="A progress note built from the client’s dispute data." actions={<MessageSquareText size={18} aria-hidden className="text-muted max-sm:hidden" />}>
          {clients.length === 0 ? <p className="text-sm text-muted">Add a client first.</p> : (
          <ul className="-mx-2 divide-y divide-line/70">{clients.slice(0, 6).map((c) => (
            <li key={c.id}><Link href={`/app/clients/${c.id}?tab=messages&draft=progress`} className="flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 text-sm hover:bg-raised"><span className="font-medium">{c.full_name}</span><span className="flex items-center gap-1 font-semibold text-brand-strong">Draft <ChevronRight size={15} aria-hidden /></span></Link></li>))}</ul>)}
        </Section>

        <Section title="Draft a dispute" hint="Start from a finding so the reason cites its evidence." actions={<Scale size={18} aria-hidden className="text-muted max-sm:hidden" />}>
          <p className="text-sm text-muted">Open a client’s comparison, choose <em>Start dispute</em> on a finding, and the reason is drafted from the reported values for you to edit.</p>
          <Link href="/app/disputes/new" className="btn-secondary mt-3">Start a dispute</Link>
        </Section>
      </div>

      <div className="mt-6"><Notice tone="info" title="New to credit repair?">The <strong>Ask the credit guide</strong> button at the top of every page explains credit reports, disputes, timelines and your clients’ rights in plain language, and points to the right screen. It answers from a built-in knowledge base and does not change anything.</Notice></div>

      <div className="mt-8 grid gap-x-8 gap-y-6 lg:grid-cols-2">
        <Section plain title="What it does"><ul className="space-y-2.5 text-sm">{CAN.map((t) => <li key={t} className="flex gap-2.5"><CheckCircle2 size={16} aria-hidden className="mt-0.5 shrink-0 text-ok" />{t}</li>)}</ul></Section>
        <Section plain title="What it will not do"><ul className="space-y-2.5 text-sm">{CANNOT.map((t) => <li key={t} className="flex gap-2.5"><Ban size={16} aria-hidden className="mt-0.5 shrink-0 text-bad" />{t}</li>)}</ul></Section>
      </div>
      <p className="mt-6 flex flex-wrap items-start gap-x-2.5 gap-y-1.5 text-xs text-muted"><AiTag /> <span className="min-w-[16rem] flex-1">When an AI provider is connected and the workspace has AI credits, it may only reword text the rules engine produced, and its output is discarded automatically if a protected passage, a number or a date changes, or if it makes a prohibited claim. What leaves the server: a letter’s connective lines only (every line with a name, an address, an account, an amount, a date or a dispute statement is replaced by a marker); a progress note’s connective sentences only (not the client’s name, not the counts); and a credit-guide question with the client’s own address, city, ZIP code, SSN last four and date of birth as they are on file, the names the app knows, and, in their common written forms, email addresses, phone numbers, Social Security, card and account numbers, dates, street addresses and amounts masked. Masking works by matching: anything else typed into a question is sent as written, such as a name or city the app does not hold, an address written with no street type, or in the client portal a creditor’s name.</span></p>
    </>
  );
}
