import type { Metadata } from 'next';
import { MessageCircle } from 'lucide-react';
import { ActionForm, SubmitButton, TextArea } from '@/components/forms';
import { PortalTitle } from '@/components/portal-kit';
import { EmptyState } from '@/components/ui';
import { portalContext } from '@/lib/portal';
import { cn, relTimeIn } from '@/lib/util';
import { portalSendMessageAction } from '../../actions';

export const metadata: Metadata = { title: 'Messages' };

export default async function PortalMessages() {
  const { ctx, t, lang } = await portalContext();
  const msgs = await ctx.tx((db) => db.rows<{ id: string; direction: string; subject: string | null; body: string; created_at: string }>("select id, direction, subject, body, created_at from public.communications order by created_at"));
  return (
    <div className="max-w-3xl space-y-6">
      <PortalTitle>{t('messagesTitle')}</PortalTitle>
      <div className="flex flex-col gap-3" aria-live="polite">
        {msgs.length === 0 ? <EmptyState title={t('noMessages')} icon={<MessageCircle size={20} />} /> : msgs.map((m) => {
          const mine = m.direction === 'inbound';
          return (
            <div key={m.id} className={cn('max-w-[88%] rounded-2xl px-4 py-3', mine ? 'self-end rounded-br-md bg-brand text-brand-ink' : 'self-start rounded-bl-md bg-surface shadow-card')}>
              {/* Who wrote it is said in words; the side and colour only repeat it. */}
              <div className={cn('mb-1 text-xs font-medium', mine ? 'text-brand-ink' : 'text-muted')}>{mine ? t('you') : t('team')} · {relTimeIn(m.created_at, lang)}</div>
              {m.subject && <div className="text-[0.9375rem] font-semibold">{m.subject}</div>}<p className="whitespace-pre-wrap text-[0.9375rem] [overflow-wrap:anywhere]">{m.body}</p>
            </div>);
        })}
      </div>
      <ActionForm action={portalSendMessageAction} resetOnSuccess className="card space-y-3 p-4 sm:p-5">
        <TextArea label={t('writeMessage')} name="body" rows={4} required maxLength={4000} />
        <SubmitButton pendingText="…">{t('send')}</SubmitButton>
      </ActionForm>
    </div>
  );
}
