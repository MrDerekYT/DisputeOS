import Link from 'next/link';
import type { Metadata } from 'next';
import { CheckCircle2, Circle, CircleDashed, CircleHelp } from 'lucide-react';
import { ActionForm, Check, Field, SubmitButton } from '@/components/forms';
import { CopyButton } from '@/components/shell-client';
import { Badge, PageHeader, Section } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { TEXTS_NEED_APPROVAL } from '@/lib/client-updates/templates';
import { APPROVAL_COLS, outreachApproval, type ApprovalRow } from '@/lib/outreach-approval';
import { buildSetupChecklist, HUMAN_ONLY, type SetupGroup, type SetupStep, type StepStatus } from '@/lib/setup/checklist';
import { loadSetupSnapshot } from '@/lib/setup/snapshot';
import { TEST_AI_LIMIT } from '@/lib/setup/test-ai';
import { TEST_SMS_LIMIT } from '@/lib/setup/test-send';
import { sendTestEmailAction, sendTestSmsAction, testAiConnectionAction } from './actions';

export const metadata: Metadata = { title: 'Get set up' };

const MARK: Record<StepStatus, { icon: typeof Circle; className: string; label: string }> = {
  done: { icon: CheckCircle2, className: 'text-ok', label: 'Done' },
  todo: { icon: Circle, className: 'text-warn', label: 'Not done' },
  cannot_check: { icon: CircleHelp, className: 'text-faint', label: 'Cannot be checked from here' },
  optional: { icon: CircleDashed, className: 'text-faint', label: 'Optional' },
};

function Step({ step, n, children }: { step: SetupStep; n: number; children?: React.ReactNode }) {
  const m = MARK[step.status];
  const Icon = m.icon;
  return (
    <li className="flex gap-3 py-4">
      <Icon size={18} aria-hidden className={`mt-0.5 shrink-0 ${m.className}`} />
      <div className="min-w-0 flex-1 text-sm">
        <h3 className="font-medium">{n}. {step.title} <span className="font-normal text-muted">· {m.label}</span></h3>
        <p className="mt-1 text-muted">{step.detail}</p>
        {step.missing && step.missing.length > 0 && (
          <p className="mt-2 flex flex-wrap items-center gap-1.5"><span className="text-[0.8125rem] text-muted">Still to set:</span>{step.missing.map((v) => <code key={v} className="rounded bg-raised px-1.5 py-0.5 text-xs">{v}</code>)}</p>
        )}
        {step.copy && (
          <div className="mt-2 flex flex-wrap items-center gap-2"><code className="block min-w-0 break-all rounded-lg bg-raised px-3 py-2 text-xs">{step.copy}</code><CopyButton value={step.copy} label="Copy address" /></div>
        )}
        {step.href && <p className="mt-2"><Link href={step.href} className="link">{step.hrefLabel}</Link></p>}
        {children}
      </div>
    </li>
  );
}

export default async function SetupPage() {
  const ctx = await requireStaff('settings:manage');
  const snap = await loadSetupSnapshot(ctx);
  const list = buildSetupChecklist(snap);
  const emailReady = list.groups[0]!.steps[0]!.status === 'done' || snap.email.driver === 'log';
  const smsReady = snap.sms.state === 'connected' || snap.sms.state === 'test_only';
  // No text leaves a workspace the platform operator has not approved under its current name: not to a client, and not this test.
  const textApproval = outreachApproval(await ctx.tx((db) => db.row<ApprovalRow>(`select ${APPROVAL_COLS} from public.organizations where id = $1`, [ctx.orgId])));
  const HINT: Record<SetupGroup['key'], string> = {
    email: 'Invitations, password resets, client updates and lead follow-ups all go out by email.',
    texts: 'Short updates to clients who agreed to texts. Sent through Twilio.',
    basics: 'Details other features quietly depend on.',
  };
  const extra = (key: string) => key === 'email_test' ? (
    <ActionForm action={sendTestEmailAction} className="mt-3">
      <SubmitButton variant="secondary" pendingText="Sending…">Send a test email to me</SubmitButton>
      <p className="hint">Goes to {ctx.session.email} only.{emailReady ? '' : ' Email is not connected yet, so this will say so.'}</p>
    </ActionForm>
  ) : key === 'sms_test' ? (
    <ActionForm action={sendTestSmsAction} className="mt-3 max-w-sm space-y-3">
      <Field label="Your mobile number" name="phone" type="tel" inputMode="tel" autoComplete="tel" required placeholder="(212) 555-0142" />
      <Check name="own" required>This is my own number and I want a test text sent to it</Check>
      <SubmitButton variant="secondary" pendingText="Sending…">Send a test text to me</SubmitButton>
      <p className="hint">Up to {TEST_SMS_LIMIT.max} a day, to US mobile numbers only. The number is not saved.{smsReady ? '' : ' Text messaging is not connected yet, so this will say so.'}</p>
      {smsReady && textApproval !== 'approved' && <p className="hint">{TEXTS_NEED_APPROVAL[textApproval]} The test text is refused until then too.</p>}
    </ActionForm>
  ) : key === 'ai' && snap.ai.state !== 'off' ? (
    <ActionForm action={testAiConnectionAction} className="mt-3">
      <SubmitButton variant="secondary" pendingText="Testing…">Test the AI connection</SubmitButton>
      <p className="hint">One short fixed request with no client data. It uses no AI credits. Up to {TEST_AI_LIMIT.max} an hour.{snap.ai.state === 'connected' ? '' : ' AI is not connected yet, so this will say so.'}</p>
    </ActionForm>
  ) : null;

  return (
    <>
      <PageHeader title="Get set up" back={{ href: '/app/settings', label: 'Settings' }}
        subtitle={list.remaining === 0 ? 'Every step this page can check has passed.' : `${list.remaining} step${list.remaining === 1 ? '' : 's'} left. Each one is read from how this app is really configured, so nothing is ticked until it works.`} />
      <div className="max-w-3xl space-y-6">
        {list.groups.map((g) => (
          <Section key={g.key} id={g.key} title={g.title} hint={HINT[g.key]}
            actions={g.remaining ? <Badge tone="warn">{g.remaining} to do</Badge> : <Badge tone="ok">Checks pass</Badge>}>
            <ol className="divide-y divide-line/70">{g.steps.map((s, i) => <Step key={s.key} step={s} n={i + 1}>{extra(s.key)}</Step>)}</ol>
          </Section>
        ))}
        <Section plain id="people" title="Only you can do these" hint="The app cannot check them, so there is nothing to tick.">
          <ul className="space-y-3 text-sm">{HUMAN_ONLY.map((h) => <li key={h.title}><span className="font-medium">{h.title}.</span> <span className="text-muted">{h.detail}</span></li>)}</ul>
        </Section>
      </div>
    </>
  );
}
