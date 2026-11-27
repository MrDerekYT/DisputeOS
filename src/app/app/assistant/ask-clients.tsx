'use client';

import Link from 'next/link';
import { useId, useRef, useState, useTransition, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowRight, ChevronDown, Loader2, Mail, MapPin, Phone, Search, Sparkles, X } from 'lucide-react';
import { AiTag, Avatar, Badge } from '@/components/ui';
import type { AssistantAnswer, HistoryItem } from '@/lib/assistant/ask';
import type { ClientCard } from '@/lib/assistant/records';
import { fmtDate } from '@/lib/util';
import { askAboutClients } from './ask-actions';

/** The same number as HISTORY_SHOWN in src/lib/assistant/ask.ts, which is server code and cannot be imported here. */
const HISTORY_SHOWN = 10;
const MAX_QUESTION = 500;

/** The two honest labels: who wrote the answer. */
const AI_LABEL = 'Answered by AI from this workspace’s records: check anything important on the client’s page';
const AI_LABEL_PERSONAL = 'Answered by AI from this workspace’s records: check anything important on the file’s own page';
const RECORDS_LABEL = 'From the records (no AI used)';

function ModeLabel({ mode, personal }: { mode: 'ai' | 'records'; personal: boolean }) {
  return mode === 'ai'
    ? <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] text-muted"><AiTag /> <span>{personal ? AI_LABEL_PERSONAL : AI_LABEL}</span></p>
    : <p className="flex flex-wrap items-center gap-2 text-[0.8125rem] text-muted"><Badge>{RECORDS_LABEL}</Badge></p>;
}

function FileCard({ card, personal }: { card: ClientCard; personal: boolean }) {
  const { email, phone, address } = card.contact;
  return (
    <article className="rounded-xl bg-surface p-4 shadow-card">
      <header className="flex flex-wrap items-center gap-3">
        <Avatar name={card.name} size={34} />
        <div className="min-w-[9rem] flex-1">
          <h4 className="break-words font-semibold leading-snug">{card.name}</h4>
          <p className="text-[0.8125rem] text-muted">{card.headline}</p>
        </div>
        <Link href={`/app/clients/${card.id}`} className="btn-secondary btn-sm">{personal ? 'Open the file' : 'Open the client’s page'} <ArrowRight size={14} aria-hidden /></Link>
      </header>
      <ul className="mt-3 flex flex-wrap gap-1.5">{card.facts.map((f) => <li key={f}><Badge>{f}</Badge></li>)}</ul>
      {(email || phone || address) && (
        <div className="mt-3 border-t border-line pt-3 text-sm">
          <ul className="space-y-1">
            {email && <li className="flex items-start gap-2"><Mail size={15} aria-hidden className="mt-0.5 shrink-0 text-muted" /><span className="[overflow-wrap:anywhere]"><span className="sr-only">Email: </span>{email}</span></li>}
            {phone && <li className="flex items-start gap-2"><Phone size={15} aria-hidden className="mt-0.5 shrink-0 text-muted" /><span><span className="sr-only">Phone: </span>{phone}</span></li>}
            {address && <li className="flex items-start gap-2"><MapPin size={15} aria-hidden className="mt-0.5 shrink-0 text-muted" /><span className="[overflow-wrap:anywhere]"><span className="sr-only">Address: </span>{address}</span></li>}
          </ul>
          <p className="mt-1.5 text-xs text-muted">Contact details are shown here from your records. They are never sent to an AI provider.</p>
        </div>
      )}
      <details className="mt-3 border-t border-line pt-3">
        <summary className="w-fit cursor-pointer rounded-md text-sm font-semibold text-brand-strong">What was read from this file</summary>
        <div className="mt-2 space-y-3 text-sm">
          {card.sections.map((s) => (
            <section key={s.key}>
              <h5 className="text-[0.8125rem] font-semibold text-muted">{s.title}</h5>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">{s.lines.map((l, i) => <li key={i} className="[overflow-wrap:anywhere]">{l}</li>)}</ul>
            </section>
          ))}
          <p className="text-xs text-muted">Notes, messages and titles are shown as they were read: shortened, with contact details and long numbers masked.</p>
        </div>
      </details>
    </article>
  );
}

export interface AskClientsProps {
  /** A personal workspace: the person's own file, with none of an agency's wording. */
  personal: boolean;
  /** An AI provider is connected and the workspace has enough credits for one answer. */
  aiReady: boolean;
  /** Why AI answers are off, when they are. */
  aiOffNote: string | null;
  credits: number;
  cost: number;
  /** The client the page was opened for (?client=). */
  pinned: { id: string; name: string } | null;
  history: HistoryItem[];
}

/**
 * "Ask about your clients": a question box, the answer, the files that were read, and the person's own last questions.
 * The answer comes from the server (./ask-actions.ts); this component only shows it. It changes nothing in a file.
 */
export function AskClients({ personal, aiReady, aiOffNote, credits, cost, pinned, history }: AskClientsProps) {
  const [text, setText] = useState('');
  const [pin, setPin] = useState(pinned);
  const [reply, setReply] = useState<AssistantAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState(history);
  const [asking, setAsking] = useState<'ai' | 'records' | null>(null);
  const [pending, start] = useTransition();
  const box = useRef<HTMLTextAreaElement>(null);
  const id = useId();

  const ask = (useAi: boolean) => {
    const q = text.replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION);
    if (!q || pending) return;
    setError(null);
    setAsking(useAi ? 'ai' : 'records');
    start(async () => {
      try {
        const r = await askAboutClients(q, pin?.id ?? null, useAi);
        if (r.ok) {
          setReply(r);
          setText('');
          // As the history keeps it: the answer, then what was said about how the question was read.
          if (r.id) setItems((prev) => [{ id: r.id!, at: r.at, question: r.question, answer: [r.answer, ...r.hints].join('\n'), mode: r.mode }, ...prev].slice(0, HISTORY_SHOWN));
        } else setError(r.error);
      } catch {
        setError('Something went wrong. Please try again.');
      }
      setAsking(null);
      box.current?.focus();
    });
  };
  const submit = (e: FormEvent) => { e.preventDefault(); ask(aiReady); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); ask(aiReady); } };
  const empty = !text.trim();
  const spin = (which: 'ai' | 'records') => pending && asking === which;

  return (
    <div className="space-y-5">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label htmlFor={`${id}-q`} className="label">Your question</label>
          <textarea ref={box} id={`${id}-q`} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} rows={2} maxLength={MAX_QUESTION} className="field text-base sm:text-sm"
            placeholder={personal ? 'For example: which disputes are past their due date?' : 'Type a client’s name and what you want to know'} />
        </div>
        {pin && (
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Asking about</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft py-1 pl-3 pr-1.5 font-semibold text-brand-strong">
              {pin.name}
              <button type="button" onClick={() => setPin(null)} aria-label={`Stop asking about ${pin.name}`} className="grid h-6 w-6 place-items-center rounded-full hover:bg-surface"><X size={14} aria-hidden /></button>
            </span>
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {aiReady && (
            <button type="submit" disabled={pending || empty} aria-busy={spin('ai')} className="btn-primary">
              {spin('ai') ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Sparkles size={16} aria-hidden />} Ask AI ({cost} credit{cost === 1 ? '' : 's'})
            </button>
          )}
          <button type={aiReady ? 'button' : 'submit'} onClick={aiReady ? () => ask(false) : undefined} disabled={pending || empty} aria-busy={spin('records')} className={aiReady ? 'btn-secondary' : 'btn-primary'}>
            {spin('records') ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Search size={16} aria-hidden />} Look up in the records (free)
          </button>
        </div>
        <p className="text-xs text-muted">
          {aiReady
            ? `AI credits: ${credits}. An AI answer costs ${cost}, taken only when one is shown. If it fails or is discarded by the safety checks, you get the answer from the records and the credits back.`
            : `${aiOffNote ?? 'AI answers are off.'} Answers come straight from the records, which costs nothing.`}
          {' '}Asking never sends, changes or deletes anything.
        </p>
      </form>

      <div aria-live="polite" aria-busy={pending}>
        {pending && <p className="text-sm text-muted">{asking === 'ai' ? 'Reading the records and asking the AI…' : 'Reading the records…'}</p>}
        {error && !pending && <p role="alert" className="rounded-xl bg-bad-soft px-3.5 py-2.5 text-sm text-bad">{error}</p>}
        {reply && !pending && (
          <div className="space-y-4 rounded-xl bg-raised p-4">
            <div className="space-y-2">
              <ModeLabel mode={reply.mode} personal={personal} />
              <p className="text-[0.8125rem] text-muted"><span className="font-semibold">You asked:</span> {reply.question}</p>
              <p className="whitespace-pre-line text-sm leading-relaxed [overflow-wrap:anywhere]">{reply.answer}</p>
              {reply.note && <p className="text-xs text-muted">{reply.note}</p>}
              {reply.hints.length > 0 && <ul className="space-y-1 text-[0.8125rem]">{reply.hints.map((h) => <li key={h} className="rounded-lg bg-surface px-3 py-2 shadow-card">{h}</li>)}</ul>}
            </div>
            {reply.cards.length > 0 && (
              <div>
                <h3 className="mb-2 text-[0.8125rem] font-semibold text-muted">{reply.cards.length === 1 ? 'The file read for this answer' : `The ${reply.cards.length} files read for this answer`}</h3>
                <div className="space-y-3">{reply.cards.map((c) => <FileCard key={c.id} card={c} personal={personal} />)}</div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-line pt-4">
        <h3 className="mb-2 text-sm font-semibold">Your last {HISTORY_SHOWN} questions</h3>
        {items.length === 0 ? <p className="text-sm text-muted">Nothing asked yet. Only you see your questions and their answers.</p> : (
          <ul className="divide-y divide-line/70 text-sm">{items.map((h) => (
            <li key={h.id} className="py-2">
              <details className="group">
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md [&::-webkit-details-marker]:hidden">
                  <span className="min-w-0 flex-1 basis-full font-medium [overflow-wrap:anywhere] sm:basis-0">{h.question}</span>
                  {h.mode === 'ai' ? <AiTag /> : <Badge>From the records</Badge>}
                  <span className="whitespace-nowrap text-xs text-muted">{fmtDate(h.at)}</span>
                  <ChevronDown size={15} aria-hidden className="shrink-0 text-muted transition-transform group-open:rotate-180" />
                </summary>
                <p className="mt-2 whitespace-pre-line rounded-lg bg-raised px-3 py-2 leading-relaxed [overflow-wrap:anywhere]">{h.answer}</p>
              </details>
            </li>))}</ul>)}
      </div>
    </div>
  );
}
