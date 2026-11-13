/**
 * The software's own name, in one place. To rename the product, change these values — every page title, email,
 * authenticator label, PDF producer tag and the logo wordmark read from here.
 *
 * Clients of an agency do not see this name in their portal: they see the agency's own name and colour, with at most a
 * small "Powered by" line (see `showPoweredBy`). Internal identifiers such as the `disputeos_rls` database role and the
 * `dos-theme` storage key are deliberately not tied to this, so renaming never needs a database migration.
 */
export const PRODUCT = {
  name: 'DisputeOS',
  /** Trailing part of the name drawn in the brand colour in the logo. Use '' for a single-colour wordmark. */
  accent: 'OS',
  tagline: 'credit repair operations, done properly',
  description:
    'The operating system for credit repair professionals: client CRM, report analysis, dispute workflow, compliant letters and a client portal.',
  /** Show "Powered by <name>" in the footer of agencies' client portals. */
  showPoweredBy: true,
} as const;

/** Splits the name into the plain part and the accent part for the two-tone wordmark. */
export function wordmarkParts(name: string = PRODUCT.name, accent: string = PRODUCT.accent): [string, string] {
  return accent && name.endsWith(accent) && name.length > accent.length ? [name.slice(0, -accent.length), accent] : [name, ''];
}
