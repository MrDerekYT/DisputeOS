export type NextKey = 'sign' | 'upload' | 'review' | 'wait' | 'prep' | 'done';

/**
 * Picks the single most useful thing to tell a client right now, from their own records only.
 * `mine` = the client has to act; otherwise the ball is in the team's (or the bureau's) court.
 */
export function nextStep(x: { needSign: boolean; needDocs: boolean; reviewing: boolean; nextDue: string | null; stage: string }): { key: NextKey; mine: boolean } {
  if (x.needSign) return { key: 'sign', mine: true };
  if (x.needDocs) return { key: 'upload', mine: true };
  if (x.reviewing) return { key: 'review', mine: false };
  if (x.nextDue) return { key: 'wait', mine: false };
  if (x.stage === 'intake' || x.stage === 'analysis' || x.stage === 'disputing') return { key: 'prep', mine: false };
  return { key: 'done', mine: false };
}
