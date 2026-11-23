import { Clock3, FileUp, ListChecks, PenLine, type LucideIcon } from 'lucide-react';
import type { WelcomeAsk } from '@/lib/onboarding';
import type { PortalKey } from '@/lib/portal-i18n';

export const SIGN_HREF = '/portal/welcome?step=agreements';

export interface WelcomeAskCopy {
  icon: LucideIcon;
  title: PortalKey;
  /** May hold `{org}`: fill it with the agency's name. */
  body: PortalKey;
  /** The client has something to do (otherwise it is the agency's to do: no button). */
  mine: boolean;
  button?: PortalKey;
  href?: string;
}

/**
 * The words for what the welcome steps ask of the client (src/lib/onboarding.ts), on the portal home and Profile:
 *  - "We can't start work until your agreements are signed" only while a document the service needs is missing;
 *  - the consent to electronic records, or the current statement, asked while work goes on, in gentler words;
 *  - while the agency finishes its service agreement: a waiting state, as the agency's to do.
 */
export function welcomeAskCopy(ask: WelcomeAsk): WelcomeAskCopy {
  switch (ask.step) {
    case 'details': return { icon: ListChecks, title: 'wl_hero_t', body: 'wl_hero_b', mine: true, button: 'wl_hero_btn', href: '/portal/welcome' };
    case 'agreements':
      if (ask.needed) return { icon: PenLine, title: 'ns_sign_t', body: 'ns_sign_b', mine: true, button: 'sign', href: SIGN_HREF };
      return ask.next === 'esign'
        ? { icon: PenLine, title: 'ns_esign_t', body: 'ns_esign_b', mine: true, button: 'sign', href: SIGN_HREF }
        : { icon: PenLine, title: 'ns_update_t', body: 'ns_update_b', mine: true, button: 'sign', href: SIGN_HREF };
    case 'documents': return { icon: FileUp, title: 'ns_intake_t', body: 'ns_intake_b', mine: true, button: 'uploadNow', href: '/portal/welcome?step=documents' };
    case 'waiting': return { icon: Clock3, title: 'ns_prepAg_t', body: 'ns_prepAg_b', mine: false };
  }
}
