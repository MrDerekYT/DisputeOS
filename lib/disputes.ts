export const BUREAUS = ['experian', 'equifax', 'transunion'] as const;
export type Bureau = (typeof BUREAUS)[number];

/** FCRA §611: 30 days to investigate, extended to 45 if consumer sends additional info. */
export function responseDueDate(sentAt: Date, extended = false): Date {
  const d = new Date(sentAt);
  d.setUTCDate(d.getUTCDate() + (extended ? 45 : 30));
  return d;
}

export function daysRemaining(due: Date, now: Date = new Date()): number {
  return Math.ceil((due.getTime() - now.getTime()) / 86_400_000);
}

export function isOverdue(due: Date, now: Date = new Date()): boolean {
  return now.getTime() > due.getTime();
}

export const BUREAU_ADDRESSES: Record<Bureau, string> = {
  experian: 'Experian, P.O. Box 4500, Allen, TX 75013',
  equifax: 'Equifax Information Services LLC, P.O. Box 740256, Atlanta, GA 30374',
  transunion: 'TransUnion Consumer Solutions, P.O. Box 2000, Chester, PA 19016',
};

export function nextRound(current: number): number | null {
  return current >= 3 ? null : current + 1;
}
