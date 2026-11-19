/**
 * An agency-configured referral link to a paid credit-monitoring service (organizations.settings).
 * It is only a link: nothing is imported through it. The agency may earn a commission, which clients are told.
 */
import { findBlockedClaims } from './compliance/claims';

/** `label` is null when the agency set no usable service name; the portal then shows a translated default. */
export interface Monitoring { url: string; label: string | null; paid: boolean }

export const MONITORING_URL_MAX = 300;
export const MONITORING_LABEL_MAX = 60;

/** A plain https link with a hostname and no embedded credentials; anything else is rejected. Returns the normalized URL. */
export function safeMonitoringUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > MONITORING_URL_MAX || /[\s<>"'`\\]/.test(s)) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || !u.hostname.includes('.') || u.username || u.password) return null;
  return u.href.length <= MONITORING_URL_MAX ? u.href : null;
}

/** Why a service name cannot be shown to clients (it is the heading of a paid offer), or null when it is fine. */
export function monitoringLabelIssue(label: string): string | null {
  const claim = findBlockedClaims(label)[0];
  if (claim) return claim.why;
  if (/\b(free|gratis|gratuit[oa]s?)\b/i.test(label)) return 'Do not call the service free: clients are shown it as a paid option.';
  return null;
}

/** Reads the stored settings and re-validates the URL, so a bad stored value is never rendered as a link or a heading. */
export function parseMonitoring(settings: unknown): Monitoring | null {
  if (!settings || typeof settings !== 'object') return null;
  const s = settings as Record<string, unknown>;
  const url = safeMonitoringUrl(s.monitoring_url);
  if (!url) return null;
  const label = typeof s.monitoring_label === 'string' ? s.monitoring_label.trim().slice(0, MONITORING_LABEL_MAX) : '';
  // The commission disclosure is shown unless the agency has explicitly said it earns nothing.
  return { url, label: label && !monitoringLabelIssue(label) ? label : null, paid: s.monitoring_paid !== false };
}
