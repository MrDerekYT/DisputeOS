import { describe, expect, it } from 'vitest';
import { polishedProgress } from '@/lib/ai/assistant';
import type { AiProvider, AiRequest } from '@/lib/ai/provider';
import { buildGuideReply } from '@/lib/guide/ask';
import { clientIdentifiers } from '@/lib/guide/steps';
import { tailorSafely } from '@/lib/letters/tailor';
import { AI_TEST_REQUEST } from '@/lib/setup/test-ai';
import { JORDAN_PII, JORDAN_QUESTION, JORDAN_RECORD, JORDAN_REDACT, JORDAN_STEPS, jordanLetter, jordanProgress, withoutCanary } from '../fixtures/jordan-rivera';

/**
 * What every AI feature sends, for one synthetic client whose name, address, account and SSN digits, date of birth and
 * email are all on file and typed into the guide. The live proof (tests/live/ai.live.test.ts) makes the same assertion
 * against the real provider; this runs on every test run, against a stand-in that records each request.
 */
const recorder = () => {
  const seen: AiRequest[] = [];
  const provider: AiProvider = { name: 'recorder', async complete(r) { seen.push(r); return 'A bureau generally has 30 days to investigate.'; } };
  return { seen, provider };
};
const leaks = (r: AiRequest) => JORDAN_PII.filter((p) => withoutCanary(`${r.system}\n${r.user}`).toLowerCase().includes(p.toLowerCase()));
/** What the guide's loaders (src/lib/guide/steps.ts) hold about Jordan besides the names: the identifiers on file. */
const JORDAN_IDENTIFIERS = clientIdentifiers({ address: JORDAN_RECORD.client.address, ssn_last4: JORDAN_RECORD.client.ssn_last4, dob: JORDAN_RECORD.client.dob });

describe('no personal data in any AI request', () => {
  it('letter suggestion, progress note (English and Spanish), guide (staff and portal) and the setup test', async () => {
    const rec = recorder();
    const letter = jordanLetter();
    expect(letter.body).toContain('Jordan Rivera'); // the letter really carries the data that must stay behind
    await tailorSafely(letter.body, letter.input, rec.provider);
    await polishedProgress(jordanProgress('en'), rec.provider);
    await polishedProgress(jordanProgress('es'), rec.provider);
    await buildGuideReply({ question: JORDAN_QUESTION, lang: 'en', audience: 'app', personal: { steps: JORDAN_STEPS, redact: JORDAN_REDACT.staff, identifiers: JORDAN_IDENTIFIERS } }, rec.provider);
    await buildGuideReply({ question: JORDAN_QUESTION, lang: 'en', audience: 'portal', personal: { steps: JORDAN_STEPS, redact: JORDAN_REDACT.portal, identifiers: JORDAN_IDENTIFIERS } }, rec.provider);
    expect(rec.seen).toHaveLength(5);
    for (const r of [...rec.seen, AI_TEST_REQUEST]) expect(leaks(r), r.user).toEqual([]);
    // The question still reaches the model as a question, with its identifiers masked.
    const portal = rec.seen[4]!.user;
    expect(portal).toContain('How long does Experian have to investigate my dispute');
    expect(portal).toMatch(/\[NAME\] \[NAME\] \(\[EMAIL\]\), born \[DATE\] \(\[DATE\]\), and I live at \[ADDRESS\], \[ADDRESS\], \[ADDRESS\], FL \[ADDRESS\]\./);
    expect(portal).toContain('card ending in [NUMBER]? My SSN ends in [SSN].');
    // In the portal a creditor's name is not redacted; on the client's page staff redaction removes it.
    expect(portal).toContain('Acme Bank');
    expect(rec.seen[3]!.user).not.toContain('Acme Bank');
    // Only the generic step label is sent, never the step's own text.
    expect(portal).toContain('An investigation is under way');
    expect(portal).not.toContain('Experian is investigating');
  });

  it('the guide also masks the forms the review found sent as typed: an SSN in spaced groups and other street types', async () => {
    const rec = recorder();
    const question = 'My SSN is 123 45 6789 (or 123 - 45 - 6789), and I moved from 12 Willow Creek Circle to 88 Pine Pl, then 7 Ocean Pkwy, last year. '
      + 'Equifax lists 22 Elm Terrace and 9 Harbor View Hwy. How long does a bureau have to investigate?';
    for (const audience of ['portal', 'app'] as const) {
      await buildGuideReply({ question, lang: 'en', audience, personal: { steps: JORDAN_STEPS, redact: JORDAN_REDACT.portal, identifiers: JORDAN_IDENTIFIERS } }, rec.provider);
    }
    expect(rec.seen).toHaveLength(2);
    for (const r of rec.seen) {
      const sent = withoutCanary(`${r.system}\n${r.user}`);
      for (const typed of ['6789', '123 45', 'Willow', 'Pine', 'Ocean', 'Elm', 'Harbor']) expect(sent, typed).not.toContain(typed);
      expect(sent).toContain('My SSN is [SSN] (or [SSN]), and I moved from [ADDRESS] to [ADDRESS], then [ADDRESS], last year. Equifax lists [ADDRESS] and [ADDRESS]');
    }
  });
});
