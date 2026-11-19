/**
 * Refusals shown after a redirect (plain form actions with no inline message area). The URL carries only a short
 * code, and the page shows the fixed sentence for it — never text taken from the query string, so a crafted link
 * cannot make the app display someone else's words as its own alert.
 */
const REFUSALS = {
  'cannot-grant-role': 'You cannot grant that role.',
  'own-role': 'You cannot change your own role.',
  'cannot-change-member': 'You cannot change that member.',
  'remove-self': 'You cannot remove yourself.',
  'cannot-remove-member': 'You cannot remove that member.',
  'own-mfa': 'You cannot reset your own two-step verification here.',
  'cannot-reset-mfa': 'That member’s two-step verification cannot be reset.',
  'version-not-found': 'Version not found.',
  'letter-not-found': 'Letter not found.',
  'letter-final': 'A sent or voided letter cannot be edited. Create a new letter instead.',
  'letter-empty': 'The letter is empty.',
} as const;

const GENERIC = 'That could not be done. Nothing was changed.';

/** The code to put in `?error=` for a refusal message raised by our own code; anything unrecognised becomes `refused`. */
export function refusalCode(message: string): string {
  return Object.entries(REFUSALS).find(([, m]) => m === message)?.[0] ?? 'refused';
}

/** The fixed sentence for an `?error=` code, or a generic one for any other value. */
export function refusalMessage(code: string): string {
  return Object.hasOwn(REFUSALS, code) ? REFUSALS[code as keyof typeof REFUSALS] : GENERIC;
}
