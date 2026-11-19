import type { Tone } from '@/components/ui';
import { PARTNER_STEPS, partnerStepLabel, type PartnerDecision, type PartnerStatus } from '@/lib/partner-emails';
import { fmtDate } from '@/lib/util';

/** Shared by the Partners list and a partner's own page, so both say the same thing about the same record. */
export const PARTNER_STATUS_TONE: Record<PartnerStatus, Tone> = {
  new: 'neutral', in_sequence: 'info', finished: 'neutral', replied: 'brand', interested: 'ok', not_interested: 'neutral', bounced: 'warn', opted_out: 'warn',
};

const TOTAL = PARTNER_STEPS.length;

/**
 * One line on where a partner stands in the email sequence, always derived from the rule the scheduled job uses
 * (decidePartnerStep). `sending` is false when the sequence is off or something it needs is missing.
 */
export function sequenceLine(d: PartnerDecision, sending: boolean, sent: number): { text: string; tone: Tone } {
  const label = (k: string) => partnerStepLabel(k).toLowerCase();
  if (d.kind === 'stop') {
    switch (d.reason) {
      case 'opted_out': return { text: 'Opted out: never emailed again', tone: 'warn' };
      case 'bounced': return { text: 'Stopped: marked as bounced', tone: 'warn' };
      case 'replied': return { text: 'Stopped: a reply is on file', tone: 'ok' };
      case 'interested': return { text: 'Stopped: interested', tone: 'ok' };
      case 'not_interested': return { text: 'Stopped: not interested', tone: 'neutral' };
      case 'finished': return { text: `All ${TOTAL} emails sent, no reply recorded`, tone: 'neutral' };
      case 'paused': return { text: `${sent} of ${TOTAL} sent, paused`, tone: 'neutral' };
      case 'failed': return { text: 'Stopped: an email was not sent. Open to see why', tone: 'bad' };
      case 'unconfirmed': return { text: 'Stopped: one email was not confirmed as sent. Contact them yourself', tone: 'bad' };
    }
  }
  if (!sending) return { text: sent ? `${sent} of ${TOTAL} sent. The sequence is not running` : 'Nothing sent. The sequence is not running', tone: 'neutral' };
  if (d.kind === 'wait') return { text: `${sent} of ${TOTAL} sent. ${label(d.step)[0]!.toUpperCase()}${label(d.step).slice(1)} due ${fmtDate(d.dueOn)}`, tone: 'info' };
  return { text: `${sent} of ${TOTAL} sent. ${label(d.step)[0]!.toUpperCase()}${label(d.step).slice(1)} goes out with the next scheduled run`, tone: 'info' };
}
