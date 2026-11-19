'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from 'react';
import { ArrowRight, ExternalLink, MessageCircleQuestion, Send, X } from 'lucide-react';
import { askStaffGuide } from '@/app/app/guide-actions';
import { askPortalGuide } from '@/app/portal/guide-actions';
import type { GuideAnswer } from '@/lib/guide/ask';
import type { GuideLabels } from '@/lib/guide/labels';
import { cn } from '@/lib/util';
import { AiTag } from './ui';

type Message = { id: number; role: 'user'; text: string } | { id: number; role: 'guide'; reply: GuideAnswer } | { id: number; role: 'error'; text: string };

const CLIENT_PAGE = /^\/app\/clients\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

function GuideLinkItem({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  if (/^https?:\/\//.test(href)) return <a href={href} target="_blank" rel="noopener noreferrer" className={className}>{children} <ExternalLink size={12} aria-hidden className="shrink-0" /></a>;
  return <Link href={href} className={className}>{children} <ArrowRight size={12} aria-hidden className="shrink-0" /></Link>;
}

/**
 * The credit guide: a small chat panel that explains credit topics from a vetted knowledge base and points to the
 * right screen. The conversation lives only in this component's state — nothing is stored, and it is gone on reload.
 * The guide never performs an account action.
 */
export function CreditGuide({ audience, labels, starters }: { audience: 'portal' | 'app'; labels: GuideLabels; starters: string[] }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [pending, start] = useTransition();
  const path = usePathname();
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const seq = useRef(0);
  const titleId = useId();
  const portal = audience === 'portal';

  // Focus moves into the panel when it opens and back to the button when it closes.
  useEffect(() => {
    if (open) input.current?.focus();
    else if (wasOpen.current) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [messages, pending]);

  const ask = (raw: string) => {
    const q = raw.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!q || pending) return;
    setText('');
    setMessages((m) => [...m, { id: ++seq.current, role: 'user', text: q }]);
    start(async () => {
      let next: Message;
      try {
        const r = portal ? await askPortalGuide(q) : await askStaffGuide(q, CLIENT_PAGE.exec(path)?.[1] ?? null);
        next = r.ok ? { id: ++seq.current, role: 'guide', reply: r } : { id: ++seq.current, role: 'error', text: r.error };
      } catch {
        next = { id: ++seq.current, role: 'error', text: labels.failed };
      }
      setMessages((m) => [...m, next]);
      input.current?.focus();
    });
  };
  const submit = (e: FormEvent) => { e.preventDefault(); ask(text); };

  // Portal: a floating round button, icon only, so it never sits on top of the page's text (the rights column on wide
  // screens, forms and instructions on phones). Its name comes from aria-label and the tooltip. The words appear beside
  // the icon only where the screen is wide enough for them to sit clear of the 64rem content column.
  // On phones it and the panel sit above the fixed bottom bar.
  // Staff app: the button lives in the top bar (this component is rendered there) and the panel opens under it.
  const bottom = 'bottom-[calc(4.5rem+env(safe-area-inset-bottom))] sm:bottom-5';
  const place = portal ? bottom : 'top-[4.25rem]';
  const chip = 'rounded-lg bg-surface px-3 py-1.5 text-left text-[0.8125rem] font-medium text-ink shadow-card transition-colors hover:bg-brand-soft disabled:opacity-50';
  const eyebrow = 'mb-1.5 text-[0.8125rem] font-semibold text-muted';

  return (
    <>
      {portal ? (
        <button ref={trigger} type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} aria-label={labels.open} title={labels.open}
          className={cn('no-print fixed right-4 z-40 inline-flex h-12 w-12 items-center justify-center gap-2 rounded-full bg-brand text-sm font-semibold text-brand-ink shadow-pop transition-colors hover:bg-brand-strong sm:right-5 min-[1800px]:w-auto min-[1800px]:px-5', bottom, open && 'hidden')}>
          <MessageCircleQuestion size={21} aria-hidden className="shrink-0" /> <span className="hidden min-[1800px]:inline">{labels.open}</span>
        </button>
      ) : (
        <button ref={trigger} type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open} aria-label={labels.open} title={labels.open}
          className="no-print btn-secondary w-[2.375rem] shrink-0 px-0 md:w-auto md:px-3.5">
          <MessageCircleQuestion size={17} aria-hidden /> <span className="hidden md:inline">{labels.open}</span>
        </button>
      )}

      {open && (
        <section role="dialog" aria-modal="false" aria-labelledby={titleId} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}
          className={cn('no-print fixed inset-x-3 z-40 flex max-h-[min(36rem,calc(100dvh-9rem))] animate-rise flex-col overflow-hidden rounded-2xl bg-surface text-left shadow-pop sm:inset-x-auto sm:right-5 sm:w-[24rem]', place)}>
          <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold"><MessageCircleQuestion size={18} aria-hidden className="text-brand-strong" /> {labels.title}</h2>
            <button type="button" onClick={() => setOpen(false)} aria-label={labels.close} className="grid h-9 w-9 place-items-center rounded-lg text-muted transition-colors hover:bg-raised hover:text-ink"><X size={18} aria-hidden /></button>
          </header>

          <div ref={log} role="log" aria-live="polite" aria-relevant="additions" aria-busy={pending} tabIndex={0} aria-label={labels.title} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
            {messages.length === 0 && (
              <div className="space-y-3">
                <p className="text-muted">{labels.intro}</p>
                <p className={eyebrow}>{labels.tryAsking}</p>
                <ul className="flex flex-col items-start gap-2">{starters.map((q) => <li key={q}><button type="button" className={chip} onClick={() => ask(q)} disabled={pending}>{q}</button></li>)}</ul>
              </div>
            )}
            {messages.map((m) => m.role === 'user' ? (
              <div key={m.id} className="flex justify-end"><p className="max-w-[85%] rounded-2xl rounded-br-md bg-brand px-3.5 py-2 font-medium text-brand-ink"><span className="sr-only">{labels.you}: </span>{m.text}</p></div>
            ) : m.role === 'error' ? (
              <p key={m.id} role="alert" className="rounded-xl bg-bad-soft px-3.5 py-2.5 text-bad">{m.text}</p>
            ) : (
              <div key={m.id} className="max-w-[95%] space-y-3 rounded-2xl rounded-bl-md bg-raised px-3.5 py-3">
                <span className="sr-only">{labels.guide}: </span>
                {(m.reply.topic || m.reply.mode === 'ai') && <p className="flex flex-wrap items-center gap-2 text-[0.8125rem] font-semibold text-muted">{m.reply.topic}{m.reply.mode === 'ai' && <AiTag>{portal ? 'AI' : 'AI wording'}</AiTag>}</p>}
                <p className="whitespace-pre-line leading-relaxed">{m.reply.answer}</p>
                {m.reply.steps.length > 0 && (
                  <div>
                    <p className={eyebrow}>{labels.forYou}</p>
                    <ol className="space-y-2">{m.reply.steps.map((s, i) => (
                      <li key={s.key} className="rounded-lg bg-surface p-2.5 shadow-card">
                        <p className="font-medium">{i + 1}. {s.href ? <GuideLinkItem href={s.href} className="inline-flex items-center gap-1 text-brand-strong hover:underline">{s.title}</GuideLinkItem> : s.title}</p>
                        <p className="mt-0.5 text-xs leading-relaxed text-muted">{s.detail}</p>
                      </li>))}</ol>
                  </div>
                )}
                {m.reply.links.length > 0 && (
                  <div>
                    <p className={eyebrow}>{labels.links}</p>
                    <ul className="flex flex-wrap gap-2">{m.reply.links.map((l) => <li key={l.href}><GuideLinkItem href={l.href} className={cn(chip, 'inline-flex items-center gap-1 text-brand-strong')}>{l.label}</GuideLinkItem></li>)}</ul>
                  </div>
                )}
                {m.reply.topics.length > 0 && (
                  <div>
                    {m.reply.topic && <p className={eyebrow}>{labels.related}</p>}
                    <ul className="flex flex-col items-start gap-2">{m.reply.topics.map((t) => <li key={t.id}><button type="button" className={chip} onClick={() => ask(t.question)} disabled={pending}>{t.question}</button></li>)}</ul>
                  </div>
                )}
                {!portal && <p className="text-xs text-muted">{m.reply.mode === 'ai' ? 'Wording by the configured AI provider, checked against the knowledge base.' : m.reply.mode === 'knowledge' ? 'Answered from the built-in knowledge base.' : 'No matching topic in the knowledge base.'}{m.reply.note ? ` ${m.reply.note}` : ''}</p>}
              </div>
            ))}
            {pending && <p className="text-muted">{labels.thinking}</p>}
          </div>

          <form onSubmit={submit} className="flex items-center gap-2 border-t border-line px-3 py-2.5">
            <label htmlFor={`${titleId}-q`} className="sr-only">{labels.question}</label>
            <input ref={input} id={`${titleId}-q`} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} autoComplete="off" enterKeyHint="send" placeholder={labels.placeholder} className="field min-w-0 flex-1 py-2 text-base sm:text-sm" />
            <button type="submit" disabled={pending || !text.trim()} aria-label={labels.send} className="btn-primary h-10 w-10 shrink-0 px-0"><Send size={16} aria-hidden /></button>
          </form>
          <p className="border-t border-line px-4 py-2.5 text-xs leading-snug text-muted">{labels.note}</p>
        </section>
      )}
    </>
  );
}
