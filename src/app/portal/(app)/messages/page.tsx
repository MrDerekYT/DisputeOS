import type { Metadata } from 'next';
import { ActionForm, SubmitButton, TextArea } from '@/components/forms';
import { EmptyState } from '@/components/ui';
import { portalContext } from '@/lib/portal';
import { cn, relTimeIn } from '@/lib/util';
import { portalSendMessageAction } from '../../actions';

export const metadata: Metadata = { title: 'Messages' };

export default async function PortalMessages() {
  const { ctx, t, lang } = await portalContext();
  const msgs = await ctx.tx((db) => db.rows<{ id: string; direction: string; subject: string | null; body: string; created_at: string }>("select id, direction, subject, body, created_at from public.communications order by created_at"));
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="font-display text-3xl font-semibold">{t('messagesTitle')}</h1>
      <div className="space-y-3" aria-live="polite">
        {msgs.length === 0 ? <EmptyState title={t('noMessages')} /> : msgs.map((m) => (
          <div key={m.id} className={cn('max-w-[88%] rounded-2xl p-4', m.direction === 'inbound' ? 'ml-auto bg-brand text-brand-ink' : 'border border-line bg-surface')}>
            <div className={cn('mb-1 text-xs', m.direction === 'inbound' ? 'text-brand-ink/80' : 'text-muted')}>{m.direction === 'inbound' ? t('you') : t('team')} · {relTimeIn(m.created_at, lang)}</div>
            {m.subject && <div className="text-sm font-medium">{m.subject}</div>}<p className="whitespace-pre-wrap text-sm">{m.body}</p>
          </div>))}
      </div>
      <ActionForm action={portalSendMessageAction} resetOnSuccess className="card space-y-3 p-4">
        <TextArea label={t('writeMessage')} name="body" rows={4} required maxLength={4000} />
        <SubmitButton pendingText="…">{t('send')}</SubmitButton>
      </ActionForm>
    </div>
  );
}
