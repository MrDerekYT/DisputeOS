import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RecommendLetter } from '@/app/app/disputes/[id]/recommend-letter';
import { LetterTailoringSetting } from '@/app/app/assistant/letter-tailoring';
import { WordingOverlapNote } from '@/app/app/letters/[id]/wording-overlap';
import { TemplatePicker } from '@/app/app/letters/new/template-picker';
import { AI_COSTS } from '@/lib/ai/credits';

// The test runner compiles JSX to React.createElement (Next.js uses the automatic runtime), so React has to be in scope when a component renders.
vi.stubGlobal('React', React);
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replace(/<!-- -->/g, '');
const REC = { templateKey: 'inaccurate_balance_en', name: 'Inaccurate balance', reason: 'The dispute is about the balance Experian reports ($1,200.00).', missing: [], exists: false };

describe('letter tailoring screens render what the rules decided, and nothing else', () => {
  it('recommended letter: the name, the one-line reason, a draft button and a way to choose another', () => {
    const out = html(createElement(RecommendLetter, { disputeId: 'd-1', clientId: 'c-1', rec: REC, canDraft: true }));
    expect(out).toContain('Recommended letter');
    expect(out).toContain('Inaccurate balance');
    expect(out).toContain('The dispute is about the balance Experian reports ($1,200.00).');
    expect(out).toContain('Draft this letter');
    expect(out).toContain('href="/app/letters/new?clientId=c-1&amp;disputeId=d-1"');
    // The letter's name is plain text, never a link: the page's own link to an existing letter stays the only one.
    expect(out).not.toMatch(/<a[^>]*>[^<]*Inaccurate balance/);
    // Nothing is shown when no letter fits, or when a letter of that kind is already on the dispute.
    expect(html(createElement(RecommendLetter, { disputeId: 'd-1', clientId: 'c-1', rec: { ...REC, exists: true }, canDraft: true }))).toBe('');
    expect(html(createElement(RecommendLetter, { disputeId: 'd-1', clientId: 'c-1', rec: { templateKey: null, name: null, reason: 'This dispute was cancelled.', missing: [], exists: false }, canDraft: true }))).toBe('');
    // A fact the letter still needs is named, and there is no button to draft around it.
    const blocked = html(createElement(RecommendLetter, { disputeId: 'd-1', clientId: 'c-1', rec: { ...REC, templateKey: 'identity_theft_block_en', name: 'Identity theft block request', missing: ['An identity theft block needs an identity theft report.'] }, canDraft: true }));
    expect(blocked).toContain('An identity theft block needs an identity theft report.');
    expect(blocked).not.toContain('Draft this letter');
  });

  it('wording overlap: low, medium or high in words, and silent when there is nothing to compare', () => {
    expect(html(createElement(WordingOverlapNote, { overlap: null }))).toBe('');
    for (const [level, label] of [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] as const) {
      const out = html(createElement(WordingOverlapNote, { overlap: { level, score: 0.5, compared: 3 } }));
      expect(out).toContain(`Wording overlap with other recent letters: <span class="badge`);
      expect(out).toContain(`>${label}</span>`);
      expect(out).toContain('Compared with 3 recent letters for other clients, here and without AI.');
    }
    expect(html(createElement(WordingOverlapNote, { overlap: { level: 'high', score: 1, compared: 1 } }))).toContain('Compared with 1 recent letter for other clients');
    // It says exactly what is measured: the whole letter, standard paragraphs included, and how much of it is shared.
    const high = html(createElement(WordingOverlapNote, { overlap: { level: 'high', score: 0.84, compared: 5 } }));
    expect(high).toContain('About 84% of its wording is in the closest one.');
    expect(high).toContain('The whole letter is counted, standard paragraphs included; names, numbers, the reason and the enclosure list are left out.');
    expect(high).toContain('the standard paragraphs are the same in every letter of this kind');
    expect(high).toContain('check that the reason states this client’s own facts');
    expect(high).not.toMatch(/requests are not compared|salutation, linking and closing lines are its own|use the suggestion below/);
  });

  it('picker: marks the recommended letter and gives the reason, and still offers every other letter', () => {
    const out = html(createElement(TemplatePicker, { selected: 'inaccurate_balance_en', own: [], advice: { value: 'inaccurate_balance_en', item: 'Acme Bank ••1234 (Experian)', reason: REC.reason, missing: [] } }));
    expect(out).toContain('Recommended for Acme Bank ••1234 (Experian).');
    expect(out).toContain(REC.reason);
    expect(out.match(/>Recommended<\/span>/g)).toHaveLength(1);
    expect(out.match(/<input[^>]*checked=""[^>]*>/g)).toEqual([expect.stringContaining('value="inaccurate_balance_en"')]);
    expect(out.match(/type="radio"/g)!.length).toBeGreaterThanOrEqual(19);
    const none = html(createElement(TemplatePicker, { selected: 'bureau_dispute_en', own: [], advice: { value: null, item: 'Acme Bank ••1234 (Experian)', reason: 'No further letter fits until a response is recorded.', missing: [] } }));
    expect(none).toContain('No letter is recommended right now for Acme Bank ••1234 (Experian).');
    expect(none).not.toMatch(/>Recommended<\/span>/);
    expect(html(createElement(TemplatePicker, { selected: 'bureau_dispute_en', own: [] }))).not.toContain('ecommended');
  });

  it('picker: a letter that does not fit the linked dispute is shown greyed out with the reason and cannot be picked', () => {
    const elsewhere = 'This dispute goes to a credit bureau, and this letter is written for a debt collector.';
    const out = html(createElement(TemplatePicker, {
      selected: 'inaccurate_balance_en', own: [],
      unavailable: { identity_theft_block_en: 'This dispute is not entered as identity theft.', validation_request_en: elsewhere, collector_communication_en: elsewhere },
    }));
    // One row inside a group that otherwise fits: disabled, with why.
    expect(out).toMatch(/<input[^>]*disabled=""[^>]*value="identity_theft_block_en"|<input[^>]*value="identity_theft_block_en"[^>]*disabled=""/);
    expect(out).toContain('Not for this dispute. This dispute is not entered as identity theft.');
    // A whole group ruled out for one reason is said once, with no rows to click.
    expect(out.match(/written for a debt collector/g)).toHaveLength(1);
    expect(out).not.toContain('value="validation_request_en"');
    expect(out).not.toContain('value="collector_communication_en"');
    // Everything else is still offered, and the selected letter is still checked.
    expect(out.match(/type="radio"/g)!.length).toBe(17);
    expect(out.match(/<input[^>]*checked=""[^>]*>/g)).toEqual([expect.stringContaining('value="inaccurate_balance_en"')]);
    expect(out.match(/disabled=""/g)).toHaveLength(1);
  });

  it('the agency setting says what it costs and that a person still approves', () => {
    const off = html(createElement(LetterTailoringSetting, { on: false }));
    expect(off).toContain('Tailor wording automatically when a letter is drafted: off');
    expect(off).toContain(`Turn on (${AI_COSTS.letter_suggestion} credits per drafted letter)`);
    expect(off).toContain('name="on" value="true"');
    const on = html(createElement(LetterTailoringSetting, { on: true }));
    expect(on).toContain('Tailor wording automatically when a letter is drafted: on');
    expect(on).toContain('a person still reads and approves it before anything is mailed');
    expect(on).toContain('Only the standard salutation, linking sentence, closing lines and sign-off can change, and only into words of courtesy; every other line of the letter is locked.');
    expect(on).toContain('name="on" value="false"');
  });
});
