import Link from 'next/link';
import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { cn, initials } from '@/lib/util';
import { PRODUCT, wordmarkParts } from '@/lib/product';

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'brand';

const TONE: Record<Tone, string> = {
  neutral: 'bg-raised text-muted ring-1 ring-inset ring-line',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  info: 'bg-info-soft text-info',
  brand: 'bg-brand-soft text-brand-strong',
};

export function Badge({ tone = 'neutral', children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={cn('badge', TONE[tone])}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

export const STATUS_TONE: Record<string, Tone> = {
  // clients
  lead: 'neutral', onboarding: 'info', active: 'ok', paused: 'warn', completed: 'brand', cancelled: 'bad',
  // disputes
  draft: 'neutral', ready_for_review: 'warn', approved: 'info', submitted: 'info', under_investigation: 'warn',
  response_received: 'brand', resolved: 'ok', on_hold: 'neutral',
  // outcomes
  deleted: 'ok', updated: 'info', verified: 'neutral', unresolved: 'warn', no_response: 'bad',
  // letters / generic
  pending_approval: 'warn', sent: 'ok', void: 'neutral', pending_review: 'warn', rejected: 'bad', accepted: 'ok',
  open: 'warn', done: 'ok', suggested: 'warn', dismissed: 'neutral', disputed: 'info',
  // findings / basis
  verified_fact: 'ok', user_provided: 'info', potential_discrepancy: 'warn',
  strong: 'warn', review: 'info', info: 'neutral',
  succeeded: 'ok', pending: 'warn', failed: 'bad', refunded: 'neutral',
  completed_run: 'ok', skipped: 'neutral',
};

export const label = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function StatusBadge({ status, text }: { status: string; text?: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'} dot>{text ?? label(status)}</Badge>;
}

export function PageHeader({ title, subtitle, actions, back }: { title: string; subtitle?: ReactNode; actions?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {back && <Link href={back.href} className="mb-1 inline-block text-xs font-medium text-muted hover:text-ink">← {back.label}</Link>}
        <h1 className="font-display text-2xl font-semibold leading-tight sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Section({ title, hint, actions, children, className, id }: { title?: string; hint?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={cn('card card-pad', id && 'scroll-mt-28', className)}>
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {hint && <p className="text-xs text-muted">{hint}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ title, body, action, icon }: { title: string; body?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-line px-6 py-12 text-center">
      <div className="mb-3 grid h-11 w-11 place-items-center rounded-full bg-brand-soft text-brand-strong">{icon ?? <Inbox size={20} />}</div>
      <h3 className="font-semibold">{title}</h3>
      {body && <p className="mt-1 max-w-sm text-sm text-muted">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Stat({ label: l, value, sub, tone, href }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; href?: string }) {
  const inner = (
    <div className={cn('card h-full p-4 sm:p-5', href && 'transition hover:border-brand/50')}>
      <div className="eyebrow">{l}</div>
      <div className={cn('mt-1.5 font-display text-3xl font-semibold tabular-nums', tone === 'bad' && 'text-bad', tone === 'warn' && 'text-warn', tone === 'ok' && 'text-ok')}>{value}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
  return href ? <Link href={href} className="block">{inner}</Link> : inner;
}

export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full bg-brand-soft font-semibold text-brand-strong"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

export function Tabs({ tabs, active }: { tabs: { key: string; label: string; href: string; count?: number }[]; active: string }) {
  return (
    <nav aria-label="Sections" className="-mx-1 mb-5 flex gap-1 overflow-x-auto border-b border-line px-1">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? 'page' : undefined}
          className={cn(
            '-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
            t.key === active ? 'border-brand text-ink' : 'border-transparent text-muted hover:text-ink',
          )}
        >
          {t.label}
          {t.count != null && t.count > 0 && <span className="rounded-full bg-raised px-1.5 text-xs text-muted ring-1 ring-inset ring-line">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

export function Notice({ tone = 'info', title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  const bar = { neutral: 'border-line', ok: 'border-ok', warn: 'border-warn', bad: 'border-bad', info: 'border-info', brand: 'border-brand' }[tone];
  return (
    <div className={cn('rounded-xl border-l-4 bg-surface px-4 py-3 text-sm shadow-card ring-1 ring-inset ring-line', bar)} role={tone === 'bad' ? 'alert' : 'note'}>
      {title && <div className="font-semibold">{title}</div>}
      <div className="text-muted">{children}</div>
    </div>
  );
}

export function DefinitionList({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs font-medium text-muted">{k}</dt>
          <dd className="mt-0.5 text-sm">{v || <span className="text-faint">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Pagination({ page, pages, hrefFor }: { page: number; pages: number; hrefFor: (p: number) => string }) {
  if (pages <= 1) return null;
  return (
    <nav aria-label="Pagination" className="mt-4 flex items-center justify-between text-sm">
      <span className="text-muted">Page {page} of {pages}</span>
      <div className="flex gap-2">
        {page > 1 && <Link className="btn-secondary btn-sm" href={hrefFor(page - 1)}>Previous</Link>}
        {page < pages && <Link className="btn-secondary btn-sm" href={hrefFor(page + 1)}>Next</Link>}
      </div>
    </nav>
  );
}

export function Logo({ size = 28, text = true }: { size?: number; text?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5 font-display text-lg font-semibold tracking-tight">
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="9" className="fill-brand" />
        <path d="M10 8.5h6.2c4.2 0 6.8 2.8 6.8 7.5s-2.6 7.5-6.8 7.5H10z" fill="none" stroke="rgb(var(--brand-ink))" strokeWidth="2.4" strokeLinejoin="round" />
        <path d="M13.6 16.2l2.2 2.2 3.8-4.4" fill="none" stroke="rgb(var(--brand-ink))" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {text && <Wordmark />}
    </span>
  );
}

/** The product name as a two-tone wordmark; driven entirely by src/lib/product.ts. */
export function Wordmark() {
  const [base, accent] = wordmarkParts();
  return <span>{base}{accent && <span className="text-brand">{accent}</span>}</span>;
}

/** An agency's own mark for the client portal: a monogram in their brand colour plus their name. */
export function OrgMark({ name, size = 30 }: { name: string; size?: number }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2.5">
      <span aria-hidden style={{ width: size, height: size }} className="grid shrink-0 place-items-center rounded-[9px] bg-brand font-display text-sm font-semibold text-brand-ink">{initials(name).slice(0, 2)}</span>
      <span className="truncate font-display text-lg font-semibold tracking-tight">{name}</span>
    </span>
  );
}

export function Disclosure({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-muted">{children}</p>;
}

export const COMPLIANCE_FOOTER =
  `${PRODUCT.name} is software for credit repair professionals. It does not provide legal advice and does not guarantee any deletion, correction, or change in credit score. Results depend on what the credit bureaus and furnishers find after investigation.`;
