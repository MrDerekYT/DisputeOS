import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { AlertCircle, AlertTriangle, ArrowLeft, CheckCircle2, Clock, Info, Sparkles } from 'lucide-react';
import { dayWindow, windowStart, windowText } from '@/lib/day-meter';
import { cn, fmtDate, initials } from '@/lib/util';
import { PRODUCT, wordmarkParts } from '@/lib/product';

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'brand';

const TONE: Record<Tone, string> = {
  neutral: 'bg-raised text-muted',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  info: 'bg-info-soft text-info',
  brand: 'bg-brand-soft text-brand-strong',
};
const TONE_TEXT: Record<Tone, string> = { neutral: 'text-ink', ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', info: 'text-info', brand: 'text-brand-strong' };

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
        {back && <Link href={back.href} className="mb-2 inline-flex items-center gap-1 text-[0.8125rem] font-medium text-muted hover:text-ink"><ArrowLeft size={14} aria-hidden /> {back.label}</Link>}
        <h1 className="display text-[1.75rem] sm:text-[2rem]">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-2xl text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/**
 * A titled block. By default it is a panel (for things that are objects: a form, a list, a record).
 * `plain` drops the panel: just the heading, a rule above and room — use it for reference content so a page is not a
 * wall of identical boxes.
 */
export function Section({ title, hint, actions, children, className, id, plain }: { title?: string; hint?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string; plain?: boolean }) {
  return (
    <section id={id} className={cn(plain ? 'border-t border-line pt-6' : 'card card-pad', id && 'scroll-mt-28', className)}>
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            {title && <h2 className="text-lg font-semibold leading-snug">{title}</h2>}
            {hint && <p className="mt-0.5 text-[0.8125rem] text-muted">{hint}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * Nothing here yet. No box: a title in the display face, one sentence, and at most one action (the iris button) — the
 * thing that would put something here. The icon is optional and decorative.
 */
export function EmptyState({ title, body, action, icon }: { title: string; body?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-4 py-12 text-center sm:py-14">
      {icon && <div className="mb-4 grid h-11 w-11 place-items-center rounded-full bg-brand-soft text-brand-strong" aria-hidden>{icon}</div>}
      <h3 className={cn('display max-w-md [text-wrap:balance]', title.length > 60 ? 'text-lg' : 'text-[1.375rem]')}>{title}</h3>
      {body && <p className="mt-2 max-w-sm text-sm text-muted">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/**
 * A number with its label — no box. A quiet rule on the left gives a row of figures its rhythm; the rule and the
 * numeral take the tone, and the label always says what the number is, so the tone is never the only signal.
 */
export function StatFigure({ label: l, value, sub, tone, href, size = 'md' }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; href?: string; size?: 'md' | 'lg' }) {
  const rule = { neutral: 'border-line', ok: 'border-ok', warn: 'border-warn', bad: 'border-bad', info: 'border-info', brand: 'border-brand' }[tone ?? 'neutral'];
  const inner = (
    <div className={cn('h-full border-l-2 py-0.5 pl-4', rule)}>
      <div className="text-[0.8125rem] font-medium text-muted">{l}</div>
      <div className={cn('display mt-1 tabular-nums', href && 'decoration-brand decoration-2 underline-offset-4 group-hover:underline', size === 'lg' ? 'text-5xl' : 'text-[2rem]', tone && tone !== 'neutral' ? TONE_TEXT[tone] : 'text-ink')}>{value}</div>
      {sub && <div className="mt-1 text-[0.8125rem] text-muted">{sub}</div>}
    </div>
  );
  return href ? <Link href={href} className="group block rounded-md">{inner}</Link> : inner;
}
/** Kept so existing pages keep working; same component as StatFigure. */
export const Stat = StatFigure;

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
    <nav aria-label="Sections" className="relative -mx-1 mb-6 flex gap-1 overflow-x-auto border-b border-line px-1">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? 'page' : undefined}
          className={cn(
            '-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm transition-colors',
            t.key === active ? 'border-brand font-semibold text-ink' : 'border-transparent font-medium text-muted hover:border-line-strong hover:text-ink',
          )}
        >
          {t.label}
          {t.count != null && t.count > 0 && <span className="rounded-full bg-raised px-1.5 text-xs font-semibold text-muted">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

const NOTICE_ICON = { neutral: Info, info: Info, brand: Info, ok: CheckCircle2, warn: AlertTriangle, bad: AlertCircle } as const;
const NOTICE_BG: Record<Tone, string> = { neutral: 'bg-raised', ok: 'bg-ok-soft', warn: 'bg-warn-soft', bad: 'bg-bad-soft', info: 'bg-info-soft', brand: 'bg-brand-soft' };

/** A short message in context. The icon carries the tone as well as the colour. */
export function Notice({ tone = 'info', title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  const Icon = NOTICE_ICON[tone];
  return (
    <div className={cn('flex gap-3 rounded-xl px-4 py-3 text-sm', NOTICE_BG[tone])} role={tone === 'bad' ? 'alert' : 'note'}>
      <Icon size={18} aria-hidden className={cn('mt-0.5 shrink-0', tone === 'neutral' ? 'text-muted' : TONE_TEXT[tone])} />
      <div className="min-w-0">
        {title && <div className="font-semibold text-ink">{title}</div>}
        <div className="text-ink/85 [overflow-wrap:anywhere]">{children}</div>
      </div>
    </div>
  );
}

export function DefinitionList({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="text-[0.8125rem] font-medium text-muted">{k}</dt>
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

/** The mark is a small window meter: days elapsed, the "today" line, days to come. */
export function Logo({ size = 28, text = true }: { size?: number; text?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5 font-display text-lg font-semibold tracking-tight">
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
        <rect width="32" height="32" rx="9" className="fill-brand" />
        <g stroke="rgb(var(--brand-ink))" strokeLinecap="round">
          <path d="M10 12.5v7" strokeWidth="2.6" />
          <path d="M14.5 10.5v11" strokeWidth="2.6" />
          <path d="M19 8v16" strokeWidth="2.6" />
          <path d="M23.2 12.5v7" strokeWidth="2.2" opacity="0.5" />
        </g>
      </svg>
      {text && <Wordmark />}
    </span>
  );
}

const METHOD_LABEL: Record<string, string> = { certified_mail: 'Certified mail', first_class_mail: 'First-class mail', portal: 'Online portal', manual: 'Other' };

/**
 * How a letter's delivery is known. "Recorded by staff" means a person typed it in; "Confirmed by carrier" is only
 * ever shown when a mail carrier integration reported it. The two are never merged.
 */
export function DeliveryRecord({ sentOn, method, tracking, source, recordedBy, carrierDeliveredAt }: {
  sentOn: string | null; method: string | null; tracking: string | null; source: string; recordedBy?: string | null; carrierDeliveredAt?: string | null;
}) {
  const carrier = source === 'carrier_confirmed';
  return (
    <div className="rounded-xl bg-raised p-3.5 text-sm" data-delivery-source={source}>
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <Badge tone={carrier ? 'ok' : 'neutral'}>{carrier ? 'Confirmed by carrier' : 'Recorded by staff'}</Badge>
        <span className="font-medium">{sentOn ? `Sent ${fmtDate(sentOn)}` : 'Sent, date not recorded'}{method ? ` · ${METHOD_LABEL[method] ?? method}` : ''}</span>
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-xs text-muted sm:grid-cols-2">
        <div><dt className="inline">Tracking reference: </dt><dd className="inline text-ink">{tracking || 'none entered'}</dd></div>
        {recordedBy && <div><dt className="inline">Entered by: </dt><dd className="inline text-ink">{recordedBy}</dd></div>}
        <div><dt className="inline">Delivery: </dt><dd className="inline text-ink">{carrier && carrierDeliveredAt ? `delivered ${fmtDate(carrierDeliveredAt)} (carrier)` : 'not confirmed by a carrier'}</dd></div>
      </dl>
      {!carrier && <p className="mt-2 text-xs text-muted">A person entered these details after mailing the letter. No carrier has confirmed delivery.</p>}
    </div>
  );
}

/** The product name as a two-tone wordmark; driven entirely by src/lib/product.ts. */
export function Wordmark() {
  const [base, accent] = wordmarkParts();
  return <span>{base}{accent && <span className="text-brand-strong">{accent}</span>}</span>;
}

/** An agency's own mark for the client portal: a monogram in their brand colour plus their name. */
export function OrgMark({ name, size = 30 }: { name: string; size?: number }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2.5">
      <span aria-hidden style={{ width: size, height: size }} className="grid shrink-0 place-items-center rounded-lg bg-brand font-display text-sm font-semibold text-brand-ink">{initials(name).slice(0, 2)}</span>
      <span className="truncate font-display text-lg font-semibold tracking-tight">{name}</span>
    </span>
  );
}

export function Disclosure({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-muted">{children}</p>;
}

export const COMPLIANCE_FOOTER =
  `${PRODUCT.name} is software for credit repair professionals. It does not provide legal advice and does not guarantee any deletion, correction, or change in credit score. Results depend on what the credit bureaus and furnishers find after investigation.`;

/**
 * The AI mark. Put it on anything a model wrote or suggested, next to the thing itself. The spark never appears on
 * content that did not come from a model. Default text is "AI"; pass children for a fuller label ("AI wording").
 */
export function AiTag({ children = 'AI', title, className }: { children?: ReactNode; title?: string; className?: string }) {
  return <span className={cn('tag-ai', className)} title={title}><Sparkles size={13} aria-hidden className="shrink-0" />{children}</span>;
}

/**
 * The investigation window, drawn from real dates: elapsed days solid, days left outlined, days past the deadline
 * hatched coral, and a pin at today. The words beside it ("Day 12 of 30", "18 days left", "6 days overdue") always say
 * the same thing as the bar, so nothing depends on colour. With no deadline it shows a dashed "not submitted yet" track.
 * The window is measured back from the stored deadline (30 days, or 45 when it was extended), so "of 30" is always the
 * legal length counted from receipt — never the gap between the mailing date and the deadline.
 *
 * Arithmetic lives in src/lib/day-meter.ts (unit-tested, same rules as the dispute workflow).
 */
export function DayMeter({ dueAt, extended, now, lang = 'en', variant = 'bar', size = 'md', showText = true, className }: {
  /** The response deadline (disputes.due_at). */
  dueAt: string | Date | null | undefined;
  /** disputes.deadline_extended: a 45-day window instead of 30. */
  extended: boolean | null | undefined;
  /** Defaults to the render time. Pass one value to every meter on a page so they agree. */
  now?: Date;
  lang?: 'en' | 'es';
  /** `ticks` draws one tick per day; use it where there is room (about 6px a day). */
  variant?: 'bar' | 'ticks';
  size?: 'sm' | 'md';
  /** Set false only when the caller prints windowText() itself right next to the bar. */
  showText?: boolean;
  className?: string;
}) {
  const w = dayWindow(windowStart(dueAt, extended), dueAt, now);
  const t = windowText(w, lang);
  const known = w.totalDays != null;
  const days = known ? (w.state === 'overdue' ? w.day! : w.totalDays!) : 30;
  const vars = { '--el': w.elapsedPct, '--left': w.leftPct, '--over': w.overPct, '--pin': w.state === 'overdue' ? 100 : w.elapsedPct, '--days': days } as CSSProperties;
  const StatusIcon = w.state === 'overdue' ? AlertTriangle : Clock;
  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5', className)} data-window-state={w.state}>
      <div className="relative min-w-[6rem] flex-1 py-1" role="img" aria-label={t.spoken}>
        {w.state === 'pending' ? <div className={cn('meter', size === 'sm' && 'meter-sm')}><i className="meter-pending" /></div> : !known ? (
          // No usable start: the length of the window is unknown, so only its state is drawn.
          <div className={cn('meter', size === 'sm' && 'meter-sm')}><i className={w.state === 'overdue' ? 'meter-over' : 'meter-left'} style={{ width: '100%', borderRadius: 4 }} /></div>
        ) : (
          <>
            <div className={cn('meter', size === 'sm' && 'meter-sm', variant === 'ticks' && 'meter-ticks', w.state === 'overdue' && 'is-over')} style={vars}>
              {w.elapsedPct > 0 && <i className="meter-el" />}
              {w.leftPct > 0 && <i className="meter-left" />}
              {w.overPct > 0 && <i className="meter-over" />}
            </div>
            <span className="meter-pin" style={{ ...vars, top: 0, bottom: 0 }} aria-hidden />
          </>
        )}
      </div>
      {showText && (
        <div className="flex shrink-0 items-center gap-x-3 whitespace-nowrap text-[0.8125rem]">
          {t.count && <span className="text-muted">{t.count}</span>}
          <span className={cn('inline-flex items-center gap-1 font-semibold', w.state === 'overdue' ? 'text-bad' : w.state === 'pending' ? 'text-muted' : 'text-ink')}>
            {w.state !== 'pending' && <StatusIcon size={13} aria-hidden />}{t.status}
          </span>
        </div>
      )}
    </div>
  );
}

/** A divided list for ListRow items. Put it inside a `.panel` (or on its own under a heading). */
export function RowList({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return <ul aria-label={label} className={cn('divide-y divide-line/70', className)}>{children}</ul>;
}

/**
 * One row of work: what it is, who or what it concerns, and the single next action.
 * `tone="bad"` marks an urgent row with a coral edge — always with an eyebrow or meta that says why in words.
 */
export function ListRow({ icon, eyebrow, tag, title, meta, detail, aside, action, tone, children }: {
  /** A lucide icon element, e.g. <Pencil size={18} />. Decorative. */
  icon?: ReactNode;
  /** Small line above the title that names the kind of row ("Letter awaiting approval"). */
  eyebrow?: ReactNode;
  /** Sits beside the eyebrow, e.g. <AiTag>AI wording</AiTag> or a <StatusBadge />. */
  tag?: ReactNode;
  title: ReactNode;
  /** Lighter text on the title line (client name, bureau). */
  meta?: ReactNode;
  /** A second line under the title. */
  detail?: ReactNode;
  /** Right-hand text before the action (a relative time, "6d overdue"). */
  aside?: ReactNode;
  /** The one action: a link button by default, or any node (a small form) when it has to submit. */
  action?: { href: string; label: string; primary?: boolean } | ReactNode;
  tone?: 'bad' | 'warn';
  /** Extra content under the text, e.g. a <DayMeter />. */
  children?: ReactNode;
}) {
  const isLink = (a: unknown): a is { href: string; label: string; primary?: boolean } => !!a && typeof a === 'object' && 'href' in a && 'label' in a;
  return (
    <li className={cn('relative flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4 sm:flex-nowrap', tone === 'bad' && 'bg-bad-soft/40', tone === 'warn' && 'bg-warn-soft/40')}>
      {tone && <span aria-hidden className={cn('absolute inset-y-0 left-0 w-[3px]', tone === 'bad' ? 'bg-bad' : 'bg-warn')} />}
      {icon && <span aria-hidden className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', tone === 'bad' ? 'bg-bad-soft text-bad' : tone === 'warn' ? 'bg-warn-soft text-warn' : 'bg-raised text-muted')}>{icon}</span>}
      <div className="min-w-0 flex-1 basis-[12rem]">
        {(eyebrow || tag) && (
          <div className="mb-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            {eyebrow && <span className={cn('text-[0.8125rem] font-semibold', tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-muted')}>{eyebrow}</span>}
            {tag}
          </div>
        )}
        <div className="text-[0.9375rem] leading-snug"><span className="font-semibold text-ink">{title}</span>{meta && <span className="text-muted"> {meta}</span>}</div>
        {detail && <div className="mt-0.5 text-sm text-muted">{detail}</div>}
        {children && <div className="mt-2">{children}</div>}
      </div>
      {(aside || action) && (
        <div className="flex shrink-0 items-center gap-4">
          {aside && <span className={cn('text-sm', tone === 'bad' ? 'font-semibold text-bad' : 'text-muted')}>{aside}</span>}
          {isLink(action) ? <Link href={action.href} className={cn(action.primary || tone === 'bad' ? 'btn-primary' : 'btn-quiet', 'btn-sm')}>{action.label}</Link> : action}
        </div>
      )}
    </li>
  );
}
