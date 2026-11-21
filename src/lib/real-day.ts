/**
 * A calendar day typed as 'YYYY-MM-DD' that really exists. JavaScript's Date rolls an impossible day over into the next
 * month (2000-02-31 becomes 2 March 2000), so a check for "not NaN" lets it through and the record later shows a date
 * nobody gave. A day is real only when it reads back unchanged. Pure: no clock, no zone.
 */
export function isRealDay(d: string): boolean {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}
