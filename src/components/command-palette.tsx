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
  useEffect(() => { if (open) setTimeout(() => input.current?.focus(), 0); }, [open]);

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
      <button type="button" onClick={() => setOpen(true)} aria-label="Search or jump to…"
        className="relative ml-1 hidden h-9 max-w-sm flex-1 items-center gap-2 rounded-full border border-line bg-surface px-3.5 text-sm text-faint transition hover:border-brand/50 sm:flex">
        <Search size={15} aria-hidden /> <span className="flex-1 text-left">Search or jump to…</span>
        <kbd className="hidden items-center gap-0.5 rounded-md border border-line bg-raised px-1.5 py-0.5 text-[11px] font-medium text-muted md:flex"><Command size={10} />K</kbd>
      </button>
      {open && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Command palette">
          <button type="button" className="absolute inset-0 bg-black/40" aria-label="Close" onClick={close} />
          <div className="relative w-full max-w-xl animate-rise overflow-hidden rounded-2xl border border-line bg-surface shadow-pop">
            <div className="flex items-center gap-3 border-b border-line px-4">
              <Search size={18} className="text-faint" aria-hidden />
              <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a client, dispute or letter — or type to filter actions" aria-label="Search"
                className="h-14 flex-1 bg-transparent text-base outline-none placeholder:text-faint"
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, shown.length - 1)); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)); }
                  else if (e.key === 'Enter') { e.preventDefault(); go(shown[i]); }
                }} />
            </div>
            <ul className="max-h-[50vh] overflow-y-auto p-2" role="listbox">
              {shown.length === 0 && <li className="px-3 py-8 text-center text-sm text-muted">No matches.</li>}
              {shown.map((it, n) => {
                const Icon = ICON[it.type] ?? CornerDownLeft;
                return (
                  <li key={`${it.href}${n}`} role="option" aria-selected={n === i}>
                    <button type="button" onMouseEnter={() => setI(n)} onClick={() => go(it)}
                      className={cn('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm', n === i ? 'bg-brand-soft text-brand-strong' : 'hover:bg-raised')}>
                      <Icon size={16} className="shrink-0 opacity-70" aria-hidden />
                      <span className="min-w-0 flex-1"><span className="block truncate font-medium">{it.title}</span>{it.sub && <span className="block truncate text-xs text-muted">{it.sub}</span>}</span>
                      <span className="shrink-0 text-xs text-faint">{it.type}</span>
                    </button>
                  </li>);
              })}
            </ul>
            <div className="flex items-center justify-between border-t border-line bg-raised px-4 py-2 text-[11px] text-muted"><span>↑↓ to move · ↵ to open · esc to close</span><span>Only your organization’s data</span></div>
          </div>
        </div>
      )}
    </>
  );
}
