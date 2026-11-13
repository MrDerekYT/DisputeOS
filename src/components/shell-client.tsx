'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import {
  BarChart3, Bell, CheckSquare, CreditCard, FileText, Gavel, Home, Inbox, Menu, Moon, ScrollText, Settings, Sparkles, Sun, Users, UsersRound, X, Zap,
} from 'lucide-react';
import { cn } from '@/lib/util';

const ICONS = { home: Home, users: Users, gavel: Gavel, file: FileText, tasks: CheckSquare, inbox: Inbox, zap: Zap, chart: BarChart3, card: CreditCard, team: UsersRound, settings: Settings, audit: ScrollText, spark: Sparkles, bell: Bell };
export type IconKey = keyof typeof ICONS;
export interface NavItem { href: string; label: string; icon: IconKey; badge?: number; group?: string }

export function NavLinks({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {items.map((it, i) => {
        const Icon = ICONS[it.icon];
        const heading = it.group && it.group !== items[i - 1]?.group ? it.group : null;
        const active = it.href === '/app' || it.href === '/portal' ? path === it.href : path === it.href || path.startsWith(`${it.href}/`);
        return (
          <Fragment key={it.href}>
          {heading && <div className={cn('px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-faint', i > 0 && 'mt-4 border-t border-line pt-4')}>{heading}</div>}
          <Link
            href={it.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
              active ? 'bg-brand-soft text-brand-strong' : 'text-muted hover:bg-raised hover:text-ink',
            )}
          >
            <Icon size={18} aria-hidden className={cn(active ? 'text-brand' : 'text-faint group-hover:text-muted')} />
            <span className="flex-1">{it.label}</span>
            {it.badge ? <span className="rounded-full bg-brand px-1.5 py-0.5 text-[11px] font-semibold leading-none text-brand-ink">{it.badge}</span> : null}
          </Link>
          </Fragment>
        );
      })}
    </nav>
  );
}

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(document.documentElement.dataset.theme === 'dark');
  }, []);
  return (
    <button
      type="button"
      className="btn-ghost btn-sm !px-2"
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => {
        const next = dark ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem('dos-theme', next); } catch { /* private mode */ }
        setDark(!dark);
      }}
    >
      {dark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

export function MobileDrawer({ items, children }: { items: NavItem[]; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open]);
  return (
    <>
      <button type="button" className="btn-ghost !px-2 lg:hidden" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}>
        <Menu size={22} />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" className="absolute inset-0 bg-black/40" aria-label="Close menu" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85%] animate-rise flex-col bg-surface p-4 shadow-pop">
            <div className="mb-3 flex justify-end">
              <button type="button" className="btn-ghost !px-2" aria-label="Close menu" onClick={() => setOpen(false)}><X size={20} /></button>
            </div>
            <div className="flex-1 overflow-y-auto"><NavLinks items={items} onNavigate={() => setOpen(false)} /></div>
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
