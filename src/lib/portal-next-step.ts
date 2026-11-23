import type { WelcomeAsk } from './onboarding';

export type NextKey = 'sign' | 'upload' | 'intake' | 'review' | 'wait' | 'prep' | 'done';

/**
 * Picks the single most useful thing to tell a client right now, from their own records only.
 * `mine` = the client has to act; otherwise the ball is in the team's (or the bureau's) court.
 * Order: agreements first, then documents — something the team asked for by name, then the identity documents checklist
 * (`needIntake`: a required identity document is missing, was rejected, or is out of date).
 */
export function nextStep(x: { needSign: boolean; needDocs: boolean; needIntake?: boolean; reviewing: boolean; nextDue: string | null; stage: string }): { key: NextKey; mine: boolean } {
  if (x.needSign) return { key: 'sign', mine: true };
  if (x.needDocs) return { key: 'upload', mine: true };
  if (x.needIntake) return { key: 'intake', mine: true };
  if (x.reviewing) return { key: 'review', mine: false };
  if (x.nextDue) return { key: 'wait', mine: false };
  if (x.stage === 'intake' || x.stage === 'analysis' || x.stage === 'disputing') return { key: 'prep', mine: false };
  return { key: 'done', mine: false };
}

/** The portal home's hero: the one answer to "what happens now?". */
export type PortalHero =
  | { kind: 'cancelled'; on: string }
  | { kind: 'welcome'; ask: WelcomeAsk }
  | { kind: 'next'; key: NextKey; mine: boolean };

/**
 * Chooses the hero from the client's own records (src/lib/onboarding.ts for `cancelledOn` and `ask`; `next` is
 * nextStep without the welcome steps):
 *  - a client who cancelled their service agreement is shown that, never asked to sign it again;
 *  - while a dispute is with a bureau or a response is being reviewed, that stays the hero: what the welcome steps
 *    still ask is listed under "What we need from you";
 *  - otherwise what the welcome steps ask comes first, then what the team or the bureaus are doing. Waiting for the
 *    agency's agreement is not the hero while the client has something of their own to do (a document the team asked for).
 */
export function portalHero(x: { cancelledOn: string | null; ask: WelcomeAsk | null; next: { key: NextKey; mine: boolean } }): PortalHero {
  if (x.cancelledOn) return { kind: 'cancelled', on: x.cancelledOn };
  const busy = x.next.key === 'wait' || x.next.key === 'review';
  if (x.ask && !busy && !(x.ask.step === 'waiting' && x.next.mine)) return { kind: 'welcome', ask: x.ask };
  return { kind: 'next', ...x.next };
}
