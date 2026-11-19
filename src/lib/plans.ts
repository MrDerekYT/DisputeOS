/**
 * PROPOSED PRICING — pending the owner's confirmation. Change the numbers here and the pricing page and its FAQ
 * follow. The page's structured data deliberately carries no prices until they are confirmed and billing is connected.
 *
 * Nothing in this file is enforced or charged: billing is not connected (docs/INTEGRATIONS.md), seat and client
 * limits are not checked anywhere, and AI credits are added by the platform operator (`npm run credits:grant`).
 * The pricing page says so. What one credit buys is NOT defined here — that is the real price list in
 * src/lib/ai/credits.ts (AI_COSTS), which the pricing page reads directly.
 */
export interface Plan {
  key: 'solo' | 'starter' | 'growth' | 'scale';
  name: string;
  /** Who the plan is for, in a few words. */
  blurb: string;
  /** US dollars per month, billed monthly. */
  priceMonthly: number;
  seats: number;
  activeClients: number;
  /** AI credits included each month. */
  aiCredits: number;
  /** Drawn with the accent on the pricing page. Exactly one plan. */
  highlight?: boolean;
}

export const PLANS: readonly Plan[] = [
  { key: 'solo', name: 'Solo', blurb: 'One person getting started', priceMonthly: 59, seats: 1, activeClients: 25, aiCredits: 150 },
  { key: 'starter', name: 'Starter', blurb: 'A small team with a steady book', priceMonthly: 119, seats: 3, activeClients: 150, aiCredits: 600, highlight: true },
  { key: 'growth', name: 'Growth', blurb: 'An established agency', priceMonthly: 229, seats: 8, activeClients: 600, aiCredits: 2500 },
  { key: 'scale', name: 'Scale', blurb: 'Several teams or locations', priceMonthly: 449, seats: 20, activeClients: 2000, aiCredits: 7000 },
];

/** Optional extras, the same price on every plan. */
export const ADD_ONS = {
  /** One more team seat, per month. */
  seatMonthly: 25,
  /** A block of extra active clients, per month. */
  clientBlock: { clients: 100, priceMonthly: 20 },
  /** A one-off pack of AI credits. */
  creditTopUp: { credits: 500, price: 29 },
} as const;

/** Must match the trial the app really gives a new workspace (src/lib/auth/service.ts: trial_ends_at = now() + 14 days). */
export const TRIAL_DAYS = 14;

export const CURRENCY = 'USD';

export const usd = (n: number) => `$${n.toLocaleString('en-US')}`;
export const count = (n: number) => n.toLocaleString('en-US');
