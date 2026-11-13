import Link from 'next/link';
import type { Metadata } from 'next';
import { Ban, CheckCircle2, FileSearch, MessageSquareText, ScanSearch, Scale, Sparkles } from 'lucide-react';
import { ActionForm, SubmitButton, TextArea } from '@/components/forms';
import { Avatar, Notice, PageHeader, Section } from '@/components/ui';
import { providerStatus } from '@/lib/ai/provider';
import { requireStaff } from '@/lib/auth/context';
import { analyzeReplyAction } from '../disputes/actions';

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
  return (
    <>
      <PageHeader title="AI assistant" subtitle="Analysis and drafting help that shows its work — and never acts on its own." />
      <div className="mb-6"><Notice tone={ai.active ? 'ok' : 'info'} title={`Engine: ${ai.provider}`}>{ai.note}</Notice></div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Analyze a client’s reports" hint="Open the three-bureau comparison and review findings." actions={<ScanSearch size={18} className="text-muted" />}>
          {clients.length === 0 ? <p className="text-sm text-muted">Add a client and upload reports first.</p> : (
            <ul className="divide-y divide-line">{clients.map((c) => (
              <li key={c.id}><Link href={c.approved ? `/app/clients/${c.id}/compare` : `/app/clients/${c.id}?tab=reports`} className="flex items-center gap-3 py-2.5 hover:bg-raised">
                <Avatar name={c.full_name} size={30} /><span className="flex-1 text-sm font-medium">{c.full_name}</span>
                <span className="text-xs text-muted">{c.approved ? `${c.findings} to review` : 'No approved report'}</span></Link></li>))}</ul>)}
        </Section>

        <Section title="Read a bureau reply" hint="Paste the text. You choose the outcome — this only suggests." actions={<FileSearch size={18} className="text-muted" />}>
          <ActionForm action={analyzeReplyAction} className="space-y-3">
            <TextArea label="Reply text" name="reply" rows={6} required placeholder="Paste the bureau or creditor response…" />
            <SubmitButton variant="secondary" pendingText="Reading…">Suggest an outcome</SubmitButton>
          </ActionForm>
        </Section>

        <Section title="Draft a client update" hint="A progress note built from the client’s dispute data." actions={<MessageSquareText size={18} className="text-muted" />}>
          <ul className="divide-y divide-line">{clients.slice(0, 6).map((c) => (
            <li key={c.id}><Link href={`/app/clients/${c.id}?tab=messages&draft=progress`} className="flex items-center justify-between py-2.5 text-sm hover:bg-raised"><span>{c.full_name}</span><span className="text-brand-strong">Draft →</span></Link></li>))}</ul>
        </Section>

        <Section title="Draft a dispute" hint="Start from a finding so the reason cites its evidence." actions={<Scale size={18} className="text-muted" />}>
          <p className="text-sm text-muted">Open a client’s comparison, choose <em>Start dispute</em> on a finding, and the reason is drafted from the reported values for you to edit.</p>
          <Link href="/app/disputes/new" className="btn-secondary mt-3">Start a dispute</Link>
        </Section>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Section title="What it does"><ul className="space-y-2.5 text-sm">{CAN.map((t) => <li key={t} className="flex gap-2.5"><CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ok" />{t}</li>)}</ul></Section>
        <Section title="What it will not do"><ul className="space-y-2.5 text-sm">{CANNOT.map((t) => <li key={t} className="flex gap-2.5"><Ban size={16} className="mt-0.5 shrink-0 text-bad" />{t}</li>)}</ul></Section>
      </div>
      <p className="mt-6 flex items-start gap-2 text-xs text-muted"><Sparkles size={14} className="mt-0.5 shrink-0" /> When an LLM is configured it may only reword text the rules engine produced. Its output is discarded automatically if any number or date changes, or if it makes a prohibited claim. Personal identifiers are removed before anything leaves the server.</p>
    </>
  );
}
