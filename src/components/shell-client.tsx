'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BarChart3, Bell, CheckSquare, CreditCard, FileText, Gavel, Globe, Handshake, Home, Inbox, Menu, Moon, ScrollText, Settings, Sparkles, Sun, UserPlus, Users, UsersRound, X, Zap,
} from 'lucide-react';
import { cn } from '@/lib/util';

const ICONS = { home: Home, users: Users, gavel: Gavel, file: FileText, tasks: CheckSquare, inbox: Inbox, zap: Zap, chart: BarChart3, card: CreditCard, team: UsersRound, settings: Settings, audit: ScrollText, spark: Sparkles, bell: Bell, lead: UserPlus, globe: Globe, handshake: Handshake };
export type IconKey = keyof typeof ICONS;
export interface NavItem { href: string; label: string; icon: IconKey; badge?: number; group?: string }

export function NavLinks({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {/* Always rendered inside a `.night` scope (the rail or the drawer), so these colours are the rail's in both themes. */}
      {items.map((it, i) => {
        const Icon = ICONS[it.icon];
        const heading = it.group && it.group !== items[i - 1]?.group ? it.group : null;
        const active = it.href === '/app' || it.href === '/portal' ? path === it.href : path === it.href || path.startsWith(`${it.href}/`);
        return (
          <Fragment key={it.href}>
          {heading && <div className={cn('px-3 pb-1.5 text-[0.8125rem] font-medium text-rail-muted', i > 0 ? 'mt-4' : 'mt-1')}>{heading}</div>}
          <Link
            href={it.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group relative flex min-h-[2.25rem] items-center gap-3 rounded-xl px-3 py-1.5 text-[0.9375rem] transition-colors',
              active ? 'bg-rail-active font-semibold text-rail-ink' : 'font-medium text-rail-muted hover:bg-rail-active/50 hover:text-rail-ink',
            )}
          >
            {active && <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-brand" />}
            <Icon size={18} strokeWidth={1.8} aria-hidden className="shrink-0" />
            <span className="flex-1">{it.label}</span>
            {it.badge ? <span className={cn('grid h-[1.375rem] min-w-[1.375rem] place-items-center rounded-full px-1.5 text-xs font-semibold tabular-nums', active ? 'bg-brand text-brand-ink' : 'bg-rail-active text-rail-ink')}>{it.badge}</span> : null}
          </Link>
          </Fragment>
        );
      })}
    </nav>
  );
}

export function ThemeToggle() {
  // Dark is the default; the page is light only when the person chose light (see THEME_BOOT in src/app/layout.tsx).
  const [dark, setDark] = useState(true);
  useEffect(() => {
    setDark(document.documentElement.dataset.theme !== 'light');
  }, []);
  return (
    <button
      type="button"
      className="grid h-[2.375rem] w-[2.375rem] shrink-0 place-items-center rounded-xl text-muted transition-colors hover:bg-raised hover:text-ink"
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => {
        const next = dark ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem('dos-theme', next); } catch { /* private mode */ }
        setDark(!dark);
      }}
    >
      {dark ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
    </button>
  );
}

export function MobileDrawer({ items, children }: { items: NavItem[]; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  useEffect(() => setOpen(false), [path]);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    // Hand focus back to the menu button when the drawer closes (it moves in via autoFocus on open).
    if (!open && wasOpen.current) trigger.current?.focus();
    wasOpen.current = open;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
      if (!open || e.key !== 'Tab' || !panel.current) return;
      // Keep Tab inside the open drawer.
      const els = Array.from(panel.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea'));
      const first = els[0], last = els[els.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (!panel.current.contains(active)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <>
      <button ref={trigger} type="button" className="-ml-1.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl text-muted transition-colors hover:bg-raised hover:text-ink lg:hidden" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}>
        <Menu size={22} />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" tabIndex={-1} className="absolute inset-0 bg-[rgb(4_6_24/0.6)]" aria-label="Close menu" onClick={() => setOpen(false)} />
          <div ref={panel} className="night absolute inset-y-0 left-0 flex w-72 max-w-[85%] animate-rise flex-col border-r border-rail-line bg-rail p-3.5 shadow-pop">
            <div className="mb-2 flex justify-end">
              <button type="button" autoFocus className="grid h-10 w-10 place-items-center rounded-xl text-rail-muted transition-colors hover:bg-rail-active hover:text-rail-ink" aria-label="Close menu" onClick={() => setOpen(false)}><X size={20} aria-hidden /></button>
            </div>
            <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1"><NavLinks items={items} onNavigate={() => setOpen(false)} /></div>
            {children}
          </div>
        </div>
      )}
    </>
  );
}

/** Copies a value to the clipboard and confirms it in place (announced to screen readers). */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(false), 2000); return () => clearTimeout(t); }, [done]);
  return (
    <button type="button" className="btn-secondary btn-sm" aria-live="polite"
      onClick={() => { navigator.clipboard?.writeText(value).then(() => setDone(true), () => setDone(false)); }}>
      {done ? 'Copied' : label}
    </button>
  );
}
