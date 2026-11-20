import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '@/lib/auth/context';
import type { SessionInfo } from '@/lib/auth/service';
import { createDispute, type DActor } from '@/lib/disputes/service';
import { styleSeed, voiceFor } from '@/lib/letters/brief';
import { createLetter, currentBody, saveVersion, setLetterStatus } from '@/lib/letters/service';
import { can, type Role } from '@/lib/rbac';
import { addClient, addMember, asUser, closePool, makeOrg, withSystem, type TestOrg } from './helpers';

// The letter actions and the letter page run here as the server runs them, with the real queries under row-level
// security. Only the sign-in step is stood in for: `requireStaff` returns a context for a real user of a test workspace.
const signedIn = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock('@/lib/auth/context', () => ({
  requireStaff: async (perm?: string) => {
    const ctx = signedIn.ctx as { can(p: string): boolean };
    if (perm && !ctx.can(perm)) throw new Error('REDIRECT /app?denied=1');
    return ctx;
  },
}));
// Outside a request there is no page cache to refresh and nowhere to redirect: the first is a no-op, the second is named.
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', async (original) => ({ ...(await original<typeof import('next/navigation')>()), redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); } }));
// The test runner compiles JSX to React.createElement, so React has to be in scope when a component renders.
vi.stubGlobal('React', React);

import { aiAcceptLetterAction, restoreVersionAction } from '@/app/app/letters/actions';
import LetterPage from '@/app/app/letters/[id]/page';

let A: TestOrg;
let owner: DActor;
let specialist: DActor;
let client = '';
let items = 0;

function signIn(role: Role = 'owner', userId = A.ownerId): void {
  const session: SessionInfo = { sessionId: 's', userId, orgId: A.orgId, role, email: A.ownerEmail, fullName: 'Test Person', mfaVerified: true, totpEnabled: false, orgName: 'Letters', orgSlug: 'letters', orgMode: 'agency', orgPlan: 'trial' };
  const ctx: Ctx = { session, userId, orgId: A.orgId, role, tx: (fn) => asUser(userId, fn), can: (p) => can(role, p), need: () => undefined, meta: { ip: '10.0.0.1', userAgent: 'vitest' } };
  signedIn.ctx = ctx;
}
const form = (fields: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.set(k, v); return fd; };
/** What a person reads on the page: the markup with tags dropped and entities decoded. */
const read = (el: React.ReactNode) => renderToStaticMarkup(el as React.ReactElement).replace(/<!-- -->/g, '')
  .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
const page = async (id: string) => read(await LetterPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }));
const versions = (id: string) => withSystem((db) => db.rows<{ version: number; source: string; change_note: string | null }>('select version, source, change_note from public.letter_versions where letter_id = $1 order by version', [id]));
const letterRow = (id: string) => withSystem((db) => db.row<{ current_version: number; status: string }>('select current_version, status from public.letters where id = $1', [id]));
const body = async (id: string) => (await withSystem((db) => currentBody(db, id)))!.body;

/** A draft dispute letter to Experian about an item of its own. */
async function draftLetter(): Promise<string> {
  const n = ++items;
  const d = await asUser(owner.userId, (db) => createDispute(db, owner, {
    clientId: client, category: 'incorrect_balance', bureau: 'experian', itemLabel: `Lakeside Finance ••55${String(n).padStart(2, '0')}`,
    reason: 'Experian reports a balance of $85.00 for Lakeside Finance. My receipt dated May 4, 2026 shows I paid it in full.', fields: ['Balance'] }));
  return asUser(owner.userId, (db) => createLetter(db, owner, { clientId: client, disputeId: d }));
}

beforeAll(async () => {
  A = await makeOrg('LetterActions');
  owner = { orgId: A.orgId, userId: A.ownerId, role: 'owner' };
  const s = await addMember(A.orgId, 'specialist');
  specialist = { orgId: A.orgId, userId: s.id, role: 'specialist' };
  client = await addClient(A.orgId, 'Pat Lee');
  await withSystem((db) => db.run(`update public.clients set address = '{"line1":"77 Lake Rd","city":"Orlando","state":"FL","zip":"32801"}' where id = $1`, [client]));
});
afterAll(closePool);

describe('restoring an earlier version of a letter', () => {
  it('an AI-worded version that is restored is still marked as AI wording; a hand-written one is not', async () => {
    signIn();
    const id = await draftLetter();
    const template = await body(id);
    const aiWorded = template.replace('Sincerely,', 'Respectfully,');
    await asUser(owner.userId, (db) => saveVersion(db, owner, id, aiWorded, 'ai_draft', 'AI wording suggestion accepted by staff (fake)'));
    await asUser(owner.userId, (db) => saveVersion(db, owner, id, aiWorded.replace('Respectfully,', 'Regards,'), 'manual_edit', 'hand edit'));
    // The hand-edited version is current: no AI mark in the header.
    expect(await page(id)).not.toContain('AI wording, not yet approved');

    await restoreVersionAction(form({ id, version: '2' }));
    expect(await versions(id)).toEqual([
      { version: 1, source: 'template', change_note: 'Generated from template' },
      { version: 2, source: 'ai_draft', change_note: 'AI wording suggestion accepted by staff (fake)' },
      { version: 3, source: 'manual_edit', change_note: 'hand edit' },
      { version: 4, source: 'ai_draft', change_note: 'Restored version 2' },
    ]);
    expect(await body(id)).toBe(aiWorded);
    expect(await letterRow(id)).toEqual({ current_version: 4, status: 'draft' });
    // The page says so: the text came from the AI and nobody has approved this version.
    const shown = await page(id);
    expect(shown).toContain('AI wording, not yet approved');
    expect(shown).toContain('The wording of this version was suggested by AI and has not been approved: read it in full before it goes for approval.');
    expect(shown).toMatch(/v4 Current AI wording PDF AI draft · LetterActions Owner · [^·]+ · Restored version 2/);

    // It still has to be sent for approval and approved by someone who may approve, like any other version.
    await expect(asUser(owner.userId, (db) => setLetterStatus(db, owner, id, 'approved'))).rejects.toThrow(/Send the letter for approval first/);
    await asUser(specialist.userId, (db) => setLetterStatus(db, specialist, id, 'pending_approval'));
    await expect(asUser(specialist.userId, (db) => setLetterStatus(db, specialist, id, 'approved'))).rejects.toThrow(/letters:approve/);
    await asUser(owner.userId, (db) => setLetterStatus(db, owner, id, 'draft'));

    // Restoring the template or the hand edit saves a version marked as edited by hand, as before.
    await restoreVersionAction(form({ id, version: '1' }));
    await restoreVersionAction(form({ id, version: '3' }));
    expect((await versions(id)).slice(4)).toEqual([{ version: 5, source: 'manual_edit', change_note: 'Restored version 1' }, { version: 6, source: 'manual_edit', change_note: 'Restored version 3' }]);
    expect(await page(id)).not.toContain('AI wording, not yet approved');
    // A version that does not exist is refused, and nothing is saved.
    await expect(restoreVersionAction(form({ id, version: '99' }))).rejects.toThrow(/^REDIRECT \/app\/letters\/[0-9a-f-]+\?error=/);
    expect(await versions(id)).toHaveLength(6);
  });
});

describe('accepting an AI wording suggestion', () => {
  it('re-checks the text on the server: a sentence nobody recorded, a name on the sign-off or a changed fact is not saved', async () => {
    signIn();
    const id = await draftLetter();
    const draft = await body(id);
    const v = voiceFor(styleSeed(client));
    const closing = [v.contact, v.thanks].filter(Boolean).join(' ');
    expect(draft).toContain(closing);
    const accept = (text: string, version = '1') => aiAcceptLetterAction(undefined, form({ id, version, text, provider: 'fake' }));

    // Whatever the browser sends is held to the same checks as the model's own result.
    const refusals: [string, RegExp][] = [
      [draft.replace(closing, 'This is mine.'), /^This suggestion was not saved: it uses wording that is not plain courtesy \(“is”\)\.$/],
      // Short enough for the shortest closing any client's voice has (30 characters allow 46), so the word list is what refuses it.
      [draft.replace(closing, 'I reached out to you about this matter.'), /not plain courtesy \(“reached”\)/],
      [draft.replace(closing, 'Please write to me at reach@my-mail.me. Thank you.'), /something that is not a plain English word \(“reach@my-mail\.me\.”\)/],
      [draft.replace(closing, 'I can šúé you.'), /characters that are not plain English letters/],
      [draft.replace('To whom it may concern:', 'Dear May:'), /the salutation is missing or is not one of the standard ones/],
      [draft.replace('Sincerely,', 'Sincerely, May'), /the sign-off is missing or is not one of the standard ones/],
      [draft.replace('To whom it may concern:', '@@').replace('Sincerely,', 'To whom it may concern:').replace('@@', 'Sincerely,'), /the salutation is missing or is not one of the standard ones/],
      [draft.replace('$85.00', '$58.00'), /a name, amount, date or dispute statement would change/],
    ];
    for (const [text, why] of refusals) {
      expect(text).not.toBe(draft);
      const r = await accept(text);
      expect(r?.error, text.slice(-120)).toMatch(why);
      expect(r?.ok).toBeUndefined();
    }
    expect(await versions(id)).toEqual([{ version: 1, source: 'template', change_note: 'Generated from template' }]);
    expect(await body(id)).toBe(draft);

    // An ordinary rewording is saved as a new draft version marked as AI wording, which still needs approval.
    const reworded = draft.replace('To whom it may concern:', 'Dear Sir or Madam:').replace(closing, [v.contact && 'You can write to me at the address above.', 'Many thanks for reading this.'].filter(Boolean).join(' ')).replace('Sincerely,', 'Respectfully,');
    expect(await accept(reworded)).toEqual({ ok: 'Saved as version 2. It is a draft: read it once more, then send it for approval.' });
    expect((await versions(id))[1]).toEqual({ version: 2, source: 'ai_draft', change_note: 'AI wording suggestion accepted by staff (fake)' });
    expect(await letterRow(id)).toEqual({ current_version: 2, status: 'draft' });
    expect(await page(id)).toContain('AI wording, not yet approved');
    // A suggestion made from a version that is no longer current is refused.
    expect((await accept(reworded))?.error).toBe('The letter changed after this suggestion was made. Ask for a new suggestion.');
  });
});

describe('the letter page', () => {
  it('says what the wording checks do, and does not say a reworded line cannot state anything', async () => {
    signIn();
    const shown = await page(await draftLetter());
    const note = /The AI sees only[^<]*?still needs approval\./.exec(shown)?.[0] ?? '';
    expect(note).toBe('The AI sees only the standard salutation, linking sentence, closing lines and sign-off, and is asked to reword them in the voice kept for this client. '
      + 'Every other line of the letter is hidden from it and put back unchanged: names, addresses, amounts, dates, account references, headings, the reason, the enclosures and every request. '
      + 'The salutation and the sign-off have to come from a short fixed list, and the reworded linking and closing lines are checked against a list of courtesy words. '
      + 'That check is a word list, so read those lines yourself: you compare before and after, and nothing is saved until you accept. An accepted suggestion is a new draft that still needs approval.');
    expect(note).not.toMatch(/words of courtesy only|cannot/);
    // One version is charged once (src/lib/letters/suggest.ts suggestForLetter).
    expect(shown).toContain('charged only when one is returned and kept for this version of the letter, so it is not charged twice.');
  });
});
