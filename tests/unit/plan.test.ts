import { describe, expect, it } from 'vitest';
import { findBlockedClaims } from '@/lib/compliance/claims';
import type { WAccount } from '@/lib/credit/what-if';
import { buildPlan, MAX_PLAN_STEPS, payToGetUnder30, type PlanInput } from '@/lib/plan';

const ID = '11111111-1111-4111-8111-111111111111';
const card = (balance: number, limit: number, over: Partial<WAccount> = {}): WAccount => ({ creditor: 'Card', type: 'Credit card', status: 'Open', balanceCents: balance * 100, limitCents: limit * 100, opened: '2020-01-01', ...over });
/** A client with an approved report and nothing outstanding. */
const base = (over: Partial<PlanInput> = {}): PlanInput => ({
  clientId: ID, firstName: 'Maria', reports: 1, reportsPendingReview: 0, missingConsents: [], findingsToReview: 0, collections: [], accounts: [], accountsBureau: 'experian',
  disputesOverdue: 0, disputesDueSoon: 0, lettersToSend: 0, ...over,
});
const keys = (over: Partial<PlanInput>) => buildPlan(base(over)).map((s) => s.key);
const everything: Partial<PlanInput> = {
  reportsPendingReview: 1, missingConsents: ['CROA disclosure', 'Service contract'], findingsToReview: 4, collections: ['Midland', 'LVNV', 'Portfolio', 'Other'],
  accounts: [card(4500, 10000)], disputesOverdue: 2, disputesDueSoon: 1, lettersToSend: 3,
};

describe('client action plan', () => {
  it('says "all caught up" as the only step when nothing applies', () => {
    const plan = buildPlan(base());
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ key: 'caught-up', tone: 'ok' });
    expect(plan[0]!.detail).toMatch(/new credit report arrives/);
  });

  it('asks for the free reports when none is on file', () => {
    const [s] = buildPlan(base({ reports: 0 }));
    expect(s).toMatchObject({ key: 'get-reports', href: `/app/clients/${ID}?tab=reports` });
    expect(s!.detail).toContain('AnnualCreditReport.com');
  });

  it('asks for the free reports again when the only reports on file were rejected (the loader does not count those)', () => {
    expect(keys({ reports: 0, reportsPendingReview: 0 })).toEqual(['get-reports']);
  });

  it('asks to check imported reports that are still pending review', () => {
    expect(keys({ reportsPendingReview: 2 })).toEqual(['review-reports']);
    expect(buildPlan(base({ reportsPendingReview: 2 }))[0]!.title).toBe('Check 2 imported reports');
  });

  it('lists the missing required consents', () => {
    const [s] = buildPlan(base({ missingConsents: ['CROA disclosure'] }));
    expect(s).toMatchObject({ key: 'consents', title: 'Collect 1 required consent', href: `/app/clients/${ID}?tab=overview#compliance` });
    expect(s!.detail).toContain('CROA disclosure');
  });

  it('never asks for consents in a personal workspace: the owner makes no agreement with themselves', () => {
    expect(keys({ self: true, missingConsents: ['Consumer Credit File Rights statement', 'Service agreement'] })).toEqual(['caught-up']);
    expect(keys({ self: true, reports: 0, missingConsents: ['Service agreement'] })).toEqual(['get-reports']);
  });

  it('counts findings waiting for review', () => {
    expect(buildPlan(base({ findingsToReview: 3 }))[0]).toMatchObject({ key: 'findings', title: 'Review 3 findings', href: `/app/clients/${ID}/compare` });
  });

  it('suggests validation for collections only when the debt is not recognised', () => {
    const [s] = buildPlan(base({ collections: ['Midland', 'LVNV', 'Portfolio', 'Other'] }));
    expect(s).toMatchObject({ key: 'collections', title: 'Look at 4 collection accounts' });
    expect(s!.detail).toContain('Midland, LVNV, Portfolio and 1 more');
    expect(s!.detail).toMatch(/If Maria does not recognise a debt, consider asking/);
    expect(s!.detail).toMatch(/reported accurately, there is nothing to dispute/);
  });

  it('shows card usage and the exact amount to get under 30%', () => {
    // $4,500 owed on $10,000 of limits = 45%. Under 30% means at most $2,999.99, so $1,500.01.
    const [s] = buildPlan(base({ accounts: [card(3000, 5000), card(1500, 5000), card(900, 0), card(800, 1000, { status: 'Closed' }), card(9000, 9000, { type: 'Auto loan' })] }));
    expect(s).toMatchObject({ key: 'card-usage', title: 'Card usage is 45% of reported limits', href: `/app/clients/${ID}/what-if?bureau=experian` });
    expect(s!.detail).toContain('$4,500.00 owed on $10,000.00 of limits across 2 open cards on the latest Experian report');
    expect(s!.detail).toContain('Paying $1,500.01 toward');
  });

  it('links the card usage step to the same bureau it quotes', () => {
    const usage = (over: Partial<PlanInput>) => buildPlan(base({ accounts: [card(4500, 10000)], ...over })).find((s) => s.key === 'card-usage')!;
    expect(usage({ accountsBureau: 'transunion' })).toMatchObject({ href: `/app/clients/${ID}/what-if?bureau=transunion` });
    expect(usage({ accountsBureau: 'transunion' }).detail).toContain('on the latest TransUnion report');
    expect(usage({ accountsBureau: null }).href).toBe(`/app/clients/${ID}/what-if`);
  });

  it('applies the 30% rule at the boundary and not below it', () => {
    expect(payToGetUnder30(450000, 1000000)).toBe(150001);
    expect(payToGetUnder30(300000, 1000000)).toBe(1);
    expect(payToGetUnder30(100, 333)).toBe(1); // 30% of $3.33 is 99.9 cents: 99 cents is the most that stays under
    expect(payToGetUnder30(299999, 1000000)).toBe(0);
    expect(keys({ accounts: [card(3000, 10000)] })).toEqual(['card-usage']);
    expect(keys({ accounts: [card(2999, 10000)] })).toEqual(['caught-up']);
    expect(keys({ accounts: [card(500, 0)] })).toEqual(['caught-up']); // no reported limit: nothing to compute
  });

  it('follows up on overdue disputes, or notes responses due soon', () => {
    expect(buildPlan(base({ disputesOverdue: 2, disputesDueSoon: 1 })).map((s) => [s.key, s.tone, s.title])).toEqual([['follow-up', 'warn', 'Follow up on 2 disputes past the response date']]);
    expect(buildPlan(base({ disputesDueSoon: 1 }))[0]).toMatchObject({ key: 'follow-up', tone: 'info', title: '1 response due within 7 days', href: `/app/clients/${ID}?tab=disputes` });
  });

  it('reminds to send approved letters', () => {
    expect(buildPlan(base({ lettersToSend: 1 }))[0]).toMatchObject({ key: 'send-letters', title: 'Send 1 approved letter', href: `/app/clients/${ID}?tab=letters` });
  });

  it('orders steps by priority and caps the list', () => {
    expect(keys(everything)).toEqual(['review-reports', 'consents', 'findings', 'collections', 'card-usage', 'follow-up']);
    expect(keys({ ...everything, reportsPendingReview: 0 })).toEqual(['consents', 'findings', 'collections', 'card-usage', 'follow-up', 'send-letters']);
    expect(buildPlan(base(everything)).length).toBeLessThanOrEqual(MAX_PLAN_STEPS);
  });

  it('is deterministic and every step links somewhere', () => {
    expect(buildPlan(base(everything))).toEqual(buildPlan(base(everything)));
    for (const s of [...buildPlan(base(everything)), ...buildPlan(base()), ...buildPlan(base({ reports: 0 }))]) expect(s.href).toMatch(/^\/app\/clients\//);
  });

  it('addresses the owner directly in a personal workspace', () => {
    const text = buildPlan(base({ self: true, reports: 0, collections: ['Midland'] })).map((s) => s.detail).join(' ');
    expect(text).toContain('You can request free reports');
    expect(text).toContain('If you do not recognise a debt');
    expect(text).not.toContain('Maria');
  });

  it('never promises a score change or an outcome (same guard used on letters)', () => {
    const variants: Partial<PlanInput>[] = [{}, { reports: 0 }, everything, { ...everything, reportsPendingReview: 0 }, { disputesDueSoon: 2 }, { ...everything, self: true }];
    for (const v of variants) {
      for (const s of buildPlan(base(v))) {
        const text = `${s.title}. ${s.detail}`;
        expect(findBlockedClaims(text), text).toEqual([]);
        expect(text).not.toMatch(/\b(raise|boost|increase|improve)\b|\d+\s*points?\b|will be (removed|deleted)|guarantee/i);
      }
    }
  });
});
