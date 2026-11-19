'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Command, CornerDownLeft, FilePlus2, Gavel, Search, UserPlus } from 'lucide-react';
import { cn } from '@/lib/util';

interface Item { type: string; title: string; sub?: string; href: string }

const ACTIONS: Item[] = [
  { type: 'Action', title: 'New client', href: '/app/clients/new' },
  { type: 'Action', title: 'New dispute', href: '/app/disputes/new' },
  { type: 'Action', title: 'New letter', href: '/app/letters/new' },
  { type: 'Go to', title: 'Dispute pipeline', href: '/app/disputes' },
  { type: 'Go to', title: 'Tasks', href: '/app/tasks' },
  { type: 'Go to', title: 'Inbox', href: '/app/inbox' },
  { type: 'Go to', title: 'Analytics', href: '/app/analytics' },
  { type: 'Go to', title: 'Developers & connections', href: '/app/settings/developers' },
];

const ICON: Record<string, typeof Search> = { Client: UserPlus, Dispute: Gavel, Letter: FilePlus2 };

/** Jump to anything: ⌘K / Ctrl+K (or “/”). Results come from a staff-only search that respects tenant isolation. */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Item[]>([]);
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  const close = useCallback(() => { setOpen(false); setQ(''); setFound([]); setI(0); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((e.target as HTMLElement)?.tagName ?? '') || (e.target as HTMLElement)?.isContentEditable;
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) { e.preventDefault(); setOpen(true); }
      else if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  useEffect(() => {
    if (open) {
      // Remember where focus was so closing the palette puts it back instead of dropping it on <body>.
      const el = document.activeElement;
      returnTo.current = el instanceof HTMLElement && el !== document.body ? el : trigger.current;
      setTimeout(() => input.current?.focus(), 0);
    } else if (returnTo.current) {
      const el = returnTo.current;
      returnTo.current = null;
      if (el.isConnected) el.focus();
    }
  }, [open]);

  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`, { signal: ctl.signal });
        if (r.ok) setFound(((await r.json()) as { results: Item[] }).results);
      } catch { /* aborted or offline */ }
    }, 150);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q]);

  const shown = q.trim().length < 2 ? ACTIONS : [...found, ...ACTIONS.filter((a) => a.title.toLowerCase().includes(q.trim().toLowerCase()))];
  useEffect(() => setI(0), [q, found.length]);
  const go = (it?: Item) => { if (!it) return; close(); router.push(it.href); };

  return (
    <>
      <button ref={trigger} type="button" onClick={() => setOpen(true)} aria-label="Search clients, disputes, letters" aria-haspopup="dialog"
        className="relative flex h-10 w-10 shrink-0 items-center justify-center gap-2.5 rounded-xl text-sm text-muted transition-colors hover:bg-raised hover:text-ink sm:h-[2.375rem] sm:w-auto sm:max-w-md sm:flex-1 sm:shrink sm:justify-start sm:border sm:border-line sm:bg-surface sm:px-3.5 sm:hover:border-line-strong sm:hover:bg-surface">
        <Search size={17} aria-hidden className="shrink-0" /> <span className="hidden min-w-0 flex-1 truncate text-left sm:inline">Search clients, disputes, letters</span>
        <kbd className="hidden items-center gap-0.5 rounded-md bg-raised px-1.5 py-0.5 font-sans text-xs font-semibold text-muted md:flex"><Command size={11} aria-hidden />K</kbd>
      </button>
      {open && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Command palette">
          <button type="button" tabIndex={-1} className="absolute inset-0 bg-[rgb(4_6_24/0.6)]" aria-label="Close" onClick={close} />
          <div className="relative w-full max-w-xl animate-rise overflow-hidden rounded-2xl bg-surface shadow-pop">
            <div className="flex items-center gap-3 border-b border-line px-4">
              <Search size={18} className="text-muted" aria-hidden />
              <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a client, dispute or letter — or type to filter actions" aria-label="Search"
                role="combobox" aria-expanded aria-controls="cp-list" aria-autocomplete="list" aria-activedescendant={shown.length ? `cp-${i}` : undefined}
                className="h-14 flex-1 bg-transparent text-base outline-none placeholder:text-faint"
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, shown.length - 1)); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)); }
                  else if (e.key === 'Enter') { e.preventDefault(); go(shown[i]); }
                  else if (e.key === 'Tab') e.preventDefault(); // the search box is the dialog's only tab stop
                }} />
            </div>
            <ul id="cp-list" className="max-h-[50vh] overflow-y-auto p-2" role="listbox" aria-label="Results">
              {shown.length === 0 && <li role="presentation" aria-live="polite" className="px-3 py-8 text-center text-sm text-muted">No matches.</li>}
              {shown.map((it, n) => {
                const Icon = ICON[it.type] ?? CornerDownLeft;
                return (
                  <li key={`${it.href}${n}`} id={`cp-${n}`} role="option" aria-selected={n === i} onMouseEnter={() => setI(n)} onClick={() => go(it)}
                    ref={n === i ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                    className={cn('flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm', n === i ? 'bg-brand-soft text-brand-strong' : 'hover:bg-raised')}>
                      <Icon size={16} className="shrink-0 opacity-70" aria-hidden />
                      <span className="min-w-0 flex-1"><span className="block truncate font-medium">{it.title}</span>{it.sub && <span className="block truncate text-xs text-muted">{it.sub}</span>}</span>
                      <span className="shrink-0 text-xs text-muted">{it.type}</span>
                  </li>);
              })}
            </ul>
            <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-xs text-muted"><span>↑↓ to move · ↵ to open · esc to close</span><span>Only your organization’s data</span></div>
          </div>
        </div>
      )}
    </>
  );
}
