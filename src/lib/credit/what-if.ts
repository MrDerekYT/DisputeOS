/**
 * "What if" arithmetic on a client's own reported accounts: credit usage, account count and account age, before and
 * after a change. It is plain arithmetic on reported figures. It deliberately does NOT estimate a credit score:
 * scoring formulas are proprietary, and a predicted increase would be an invented number and an implied promise.
 */
export interface WAccount { creditor: string; type: string | null; status: string | null; balanceCents: number | null; limitCents: number | null; opened: string | null }
export interface Snapshot {
  openAccounts: number; revolvingAccounts: number; revolvingBalanceCents: number; revolvingLimitCents: number;
  /** Revolving balance divided by revolving limit, as a percentage with one decimal; null when no limits are reported. */
  utilizationPct: number | null; averageAgeMonths: number | null; oldestAgeMonths: number | null;
}
export interface Scenario { payDownCents?: number; add?: { limitCents: number; balanceCents: number; opened: string } | null }

export const isOpen = (a: WAccount) => !/closed|paid|transferred|sold|charge.?off|collection/i.test(a.status ?? '');
export const isRevolving = (a: WAccount) => (a.limitCents ?? 0) > 0 && !/install|mortgage|auto|student|loan/i.test(a.type ?? '');

const months = (from: string, asOf: Date) => {
  const d = new Date(from.length === 10 ? `${from}T00:00:00Z` : from);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, (asOf.getUTCFullYear() - d.getUTCFullYear()) * 12 + (asOf.getUTCMonth() - d.getUTCMonth()));
};

export function snapshot(accounts: WAccount[], asOf = new Date()): Snapshot {
  const open = accounts.filter(isOpen);
  const rev = open.filter(isRevolving);
  const bal = rev.reduce((s, a) => s + Math.max(0, a.balanceCents ?? 0), 0);
  const lim = rev.reduce((s, a) => s + (a.limitCents ?? 0), 0);
  const ages = open.map((a) => (a.opened ? months(a.opened, asOf) : null)).filter((m): m is number => m != null);
  return {
    openAccounts: open.length, revolvingAccounts: rev.length, revolvingBalanceCents: bal, revolvingLimitCents: lim,
    utilizationPct: lim > 0 ? Math.round((bal / lim) * 1000) / 10 : null,
    averageAgeMonths: ages.length ? Math.round(ages.reduce((s, m) => s + m, 0) / ages.length) : null,
    oldestAgeMonths: ages.length ? Math.max(...ages) : null,
  };
}

/** Applies a change to a copy of the accounts. A pay-down goes to the most heavily used cards first. */
export function applyScenario(accounts: WAccount[], s: Scenario): WAccount[] {
  const out = accounts.map((a) => ({ ...a }));
  let left = Math.max(0, Math.floor(s.payDownCents ?? 0));
  if (left > 0) {
    const cards = out.filter((a) => isOpen(a) && isRevolving(a) && (a.balanceCents ?? 0) > 0)
      .sort((x, y) => (y.balanceCents! / y.limitCents!) - (x.balanceCents! / x.limitCents!));
    for (const c of cards) {
      const pay = Math.min(left, c.balanceCents!);
      c.balanceCents = c.balanceCents! - pay;
      left -= pay;
      if (left <= 0) break;
    }
  }
  if (s.add && s.add.limitCents > 0) {
    const limit = Math.floor(s.add.limitCents);
    out.push({ creditor: 'Added account (what-if)', type: 'revolving', status: 'open', limitCents: limit, balanceCents: Math.max(0, Math.min(Math.floor(s.add.balanceCents), limit)), opened: s.add.opened });
  }
  return out;
}

export const ageLabel = (m: number | null) => (m == null ? '—' : m < 12 ? `${m} mo` : `${Math.floor(m / 12)} yr ${m % 12} mo`);
