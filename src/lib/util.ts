export const cn = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export const BUREAUS = ['experian', 'equifax', 'transunion'] as const;
export type Bureau = (typeof BUREAUS)[number];
export const BUREAU_LABEL: Record<Bureau, string> = { experian: 'Experian', equifax: 'Equifax', transunion: 'TransUnion' };

export const money = (cents: number | null | undefined) =>
  cents == null ? '—' : (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export const moneyShort = (cents: number) => {
  const d = cents / 100;
  if (Math.abs(d) >= 1_000_000) return `$${(d / 1_000_000).toFixed(1)}M`;
  if (Math.abs(d) >= 10_000) return `$${(d / 1000).toFixed(1)}k`;
  return d.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
};

/** Short date (e.g. "Mar 3, 2026" / "3 mar 2026"). `lang` localises the client portal. */
export function fmtDate(v: string | Date | null | undefined, lang: 'en' | 'es' = 'en'): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v.length === 10 ? `${v}T00:00:00Z` : v) : v;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** Relative time in words for clients ("2 days ago" / "hace 2 días"). */
export function relTimeIn(v: string | Date | null | undefined, lang: 'en' | 'es' = 'en', now = new Date()): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  const s = Math.round((d.getTime() - now.getTime()) / 1000);
  const f = new Intl.RelativeTimeFormat(lang === 'es' ? 'es' : 'en', { numeric: 'auto' });
  const units: [number, Intl.RelativeTimeFormatUnit][] = [[86400 * 30, 'month'], [86400 * 7, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [secs, unit] of units) if (Math.abs(s) >= secs) return f.format(Math.trunc(s / secs), unit);
  return f.format(0, 'second');
}

/** Whole days from `now` until `v` (negative when past). */
export const daysUntil = (v: string | Date, now = new Date()) => Math.ceil(((typeof v === 'string' ? new Date(v) : v).getTime() - now.getTime()) / 86_400_000);

export function relTime(v: string | Date | null | undefined, now = new Date()): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  const s = Math.round((d.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(s);
  const units: [number, string][] = [[86400 * 30, 'mo'], [86400, 'd'], [3600, 'h'], [60, 'm']];
  for (const [secs, label] of units) {
    if (abs >= secs) {
      const n = Math.floor(abs / secs);
      return s < 0 ? `${n}${label} ago` : `in ${n}${label}`;
    }
  }
  return 'just now'; // under a minute either way: tiny clock differences between app and database must not read as "in <1m"
}

export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';

export const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export const slugify = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'org';
