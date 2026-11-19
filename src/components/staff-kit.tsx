import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/util';

/**
 * Small pieces shared by the staff workspace pages (clients, letters, leads, settings).
 * Nothing here reads data: every count and label is passed in by the page that queried it.
 */

/** A row of filter links. The chosen one is marked with aria-current and a heavier weight, not by colour alone. */
export function FilterChips({ label, items }: { label: string; items: { key: string; label: string; href: string; count?: number | null; active: boolean }[] }) {
  return (
    <nav aria-label={label} className="relative -mx-1 mb-4 flex gap-1.5 overflow-x-auto px-1 pb-1">
      {items.map((i) => (
        <Link key={i.key} href={i.href} aria-current={i.active ? 'page' : undefined}
          className={cn('flex min-h-[2.25rem] shrink-0 items-center gap-2 rounded-full px-3.5 text-sm transition-colors',
            i.active ? 'bg-brand-soft font-semibold text-brand-strong shadow-[inset_0_0_0_1px_rgb(var(--brand)/0.6)]' : 'font-medium text-muted hover:bg-raised hover:text-ink')}>
          {i.label}
          {i.count != null && <span className={cn('text-xs tabular-nums', i.active ? 'text-brand-strong' : 'text-faint')}>{i.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

/**
 * True while a letter's current text is an AI draft that no person has approved yet.
 * `source` is letter_versions.source of the current version. A letter that is approved or sent was approved by a
 * person as exactly that text, so the AI mark comes off; editing it makes a new version with its own source.
 */
export const aiUnapproved = (l: { source: string | null; status: string }) => l.source === 'ai_draft' && l.status !== 'approved' && l.status !== 'sent';

/** How a credit report reached the workspace (credit_reports.source), in words. */
export const REPORT_SOURCE_LABEL: Record<string, string> = { upload: 'file upload', csv: 'CSV import', provider: 'API or provider connection', manual: 'manual entry' };

/** A link the agency hands out (sign-in page, enquiry form): the address in full, then what you can do with it. */
export function ShareLink({ title, hint, url, children }: { title?: string; hint?: ReactNode; url: string; children: ReactNode }) {
  return (
    <div>
      {title && <div className="text-sm font-semibold">{title}</div>}
      {hint && <p className="mt-0.5 text-[0.8125rem] text-muted">{hint}</p>}
      <code className={cn('block break-all rounded-lg bg-raised px-3 py-2 text-xs', title || hint ? 'mt-3' : undefined)}>{url}</code>
      <div className="mt-3 flex flex-wrap gap-2">{children}</div>
    </div>
  );
}
