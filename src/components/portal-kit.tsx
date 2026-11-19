import type { ReactNode } from 'react';
import { cn } from '@/lib/util';

/** The page title of a client portal page, with an optional plain-words line under it. */
export function PortalTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <header>
      <h1 className="display text-[2rem] sm:text-[2.25rem]">{children}</h1>
      {sub && <p className="mt-2 max-w-xl text-[0.9375rem] text-muted">{sub}</p>}
    </header>
  );
}

/**
 * A titled part of a portal page with no box around it: a heading, an optional line of context, then the content.
 * Boxes (`.card`) are kept for things the client acts on — a form, an item, a list of files.
 */
export function PortalBlock({ id, title, hint, children, className }: { id: string; title: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn('scroll-mt-28', className)}>
      <h2 id={`${id}-title`} className="display text-[1.375rem]">{title}</h2>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** A dated line in a list of updates: the date on the left, what happened on the right. Use inside `<ul className="divide-y divide-line">`. */
export function DatedRow({ date, children }: { date: string; children: ReactNode }) {
  return (
    <li className="flex gap-4 py-3 text-[0.9375rem]">
      <span className="w-[5.75rem] shrink-0 pt-0.5 text-[0.8125rem] text-muted">{date}</span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </li>
  );
}

/**
 * An inline message on the sign-in and public pages, where the live-region role matters (`status` for good news,
 * `alert` for a problem). The icon carries the tone as well as the colour.
 */
export function InlineMessage({ tone, role, icon, children, className }: { tone: 'ok' | 'warn'; role?: 'status' | 'alert'; icon: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div role={role} className={cn('flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-sm text-ink', tone === 'ok' ? 'bg-ok-soft' : 'bg-warn-soft', className)}>
      <span aria-hidden className={cn('mt-0.5 shrink-0', tone === 'ok' ? 'text-ok' : 'text-warn')}>{icon}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
