import { describe, expect, it } from 'vitest';
import { monitoringLabelIssue, parseMonitoring, safeMonitoringUrl } from '@/lib/monitoring';

describe('credit-monitoring referral link', () => {
  it('returns null when no link is set', () => {
    for (const s of [null, undefined, 'x', {}, { monitoring_url: '' }, { monitoring_label: 'SmartCredit' }, { monitoring_url: 42 }]) expect(parseMonitoring(s)).toBeNull();
  });
  it('accepts https links only', () => {
    expect(safeMonitoringUrl(' https://www.example.com/?aid=123 ')).toBe('https://www.example.com/?aid=123');
    for (const bad of ['http://example.com', 'javascript:alert(1)', 'data:text/html,x', 'ftp://example.com', '//example.com', 'example.com', 'https://', 'https://localhost',
      'https://user:pw@example.com', 'https://user@example.com', 'https://example.com/"onclick="x', 'https://example.com/a b', `https://example.com/${'a'.repeat(300)}`]) {
      expect(safeMonitoringUrl(bad), bad).toBeNull();
      expect(parseMonitoring({ monitoring_url: bad, monitoring_label: 'X' }), bad).toBeNull();
    }
  });
  it('trims the label and leaves it empty when none is set (the portal shows a translated default)', () => {
    expect(parseMonitoring({ monitoring_url: 'https://example.com/r', monitoring_label: '  SmartCredit  ', monitoring_paid: true })).toEqual({ url: 'https://example.com/r', label: 'SmartCredit', paid: true });
    expect(parseMonitoring({ monitoring_url: 'https://example.com/r', monitoring_label: '   ' })!.label).toBeNull();
    expect(parseMonitoring({ monitoring_url: 'https://example.com/r', monitoring_label: 'x'.repeat(200) })!.label).toHaveLength(60);
  });
  it('rejects a service name that makes a promise or calls the paid service free', () => {
    for (const bad of ['Guaranteed 100-point boost', 'Free credit monitoring', 'Monitoreo gratis', 'Raise your score by 100']) {
      expect(monitoringLabelIssue(bad), bad).toBeTruthy();
      expect(parseMonitoring({ monitoring_url: 'https://example.com/r', monitoring_label: bad })!.label, bad).toBeNull();
    }
    for (const ok of ['SmartCredit', 'IdentityIQ', 'Freedom Credit Watch']) expect(monitoringLabelIssue(ok), ok).toBeNull();
  });
  it('discloses a commission unless the agency explicitly said there is none', () => {
    expect(parseMonitoring({ monitoring_url: 'https://example.com/r' })!.paid).toBe(true);
    expect(parseMonitoring({ monitoring_url: 'https://example.com/r', monitoring_paid: 'false' })!.paid).toBe(true);
    expect(parseMonitoring({ monitoring_url: 'https://example.com/r', monitoring_paid: false })!.paid).toBe(false);
  });
});
