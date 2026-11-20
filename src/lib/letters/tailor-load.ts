/**
 * The database side of AI wording for letters (./tailor.ts holds the rules): what one letter's tailoring needs, the
 * agency's other recent letters for the overlap check, and the optional "tailor when a letter is drafted" setting.
 * Every read runs in the caller's tenant transaction, so row-level security keeps it inside their organization.
 */
import { getProvider, type AiProvider } from '../ai/provider';
import { parseAgencyItem } from '../credit/agencies';
import type { Db } from '../db';
import { styleSeed } from './brief';
import { comparableWording, wordingOverlap, type WordingOverlap } from './overlap';
import { reasonInLetter } from './specificity';
import { currentBody, saveVersion, specificityInputFor, type LActor } from './service';
import { suggestForLetter, type Tx } from './suggest';
import { letterTerms, reasonLinesFrom, tailorIssue, type TailorInput } from './tailor';
import { templateByKey } from './templates';

type Address = { line1?: string; line2?: string; city?: string } | null;

export interface TailorSubject extends Required<Pick<TailorInput, 'protectedTerms' | 'seed'>> {
  clientId: string; status: string; body: string; version: number;
  specificity: TailorInput['specificity'];
  /** The letter's wording with this client's own facts taken out: what the overlap score compares (./overlap.ts). */
  comparable: string;
}

/**
 * A letter's text as the overlap score reads it: the client's names, the recipient, the creditor, the item and the
 * reason (as the letter states it now) are taken out; the standard paragraphs stay.
 */
function comparable(r: { body: string; full_name: string; address: Address; names: (string | null | undefined)[]; reason: string | null; templateBody?: string | null }): string {
  const lines = r.body.replace(/\r\n?/g, '\n').split('\n'); // line ends as comparableWording reads them
  let reasonLines = r.templateBody ? reasonLinesFrom(r.templateBody, r.body) : [];
  if (!reasonLines.length) {
    const stated = reasonInLetter(r.body, r.reason ?? '').replace(/\s+/g, ' ').trim();
    // With no reason heading and no stored reason the whole letter comes back: then nothing can be told apart as the reason.
    if (stated && stated.length < r.body.replace(/\s+/g, ' ').trim().length) reasonLines = lines.filter((l) => l.trim().length >= 4 && stated.includes(l.replace(/\s+/g, ' ').trim()));
  }
  return comparableWording(r.body, { lines: reasonLines, names: [r.full_name, ...r.full_name.split(/\s+/).filter((w) => w.length > 2), r.address?.line1, r.address?.line2, r.address?.city, ...r.names] });
}

/** The current text of a letter with everything its tailoring needs: the terms to lock, the client's style seed and the specificity inputs. */
export async function loadTailorSubject(db: Db, letterId: string): Promise<TailorSubject | null> {
  const r = await db.row<{
    client_id: string; status: string; body: string; version: number; full_name: string; address: Address; letter_recipient: string;
    template_key: string | null; own_template: string | null; recipient_name: string | null; item_label: string | null; reason: string | null; agency_item: unknown;
    creditor_name: string | null; original_creditor: string | null; account_status: string | null; payment_status: string | null;
  }>(
    `select l.client_id, l.status, v.body, v.version, c.full_name, c.address, l.recipient_name as letter_recipient, l.template_key, lt.body as own_template,
            d.recipient_name, d.item_label, d.reason, d.agency_item, t.creditor_name, t.original_creditor, t.account_status, t.payment_status
       from public.letters l join public.clients c on c.id = l.client_id
       join public.letter_versions v on v.letter_id = l.id and v.version = l.current_version
       left join public.disputes d on d.id = l.dispute_id left join public.tradelines t on t.id = d.tradeline_id
       left join public.letter_templates lt on l.template_key = 'org:' || lt.id::text
      where l.id = $1`, [letterId]);
  if (!r) return null;
  const item = parseAgencyItem(r.agency_item);
  const templateBody = templateByKey(r.template_key ?? '')?.body ?? r.own_template;
  const names = [r.letter_recipient, r.recipient_name, r.creditor_name, r.original_creditor, r.item_label, item?.name, item?.reference];
  return {
    clientId: r.client_id, status: r.status, body: r.body, version: r.version, seed: styleSeed(r.client_id),
    // letterTerms locks every line of the body by position; the names and facts are listed too, so they stay locked
    // wherever else they might be written.
    protectedTerms: letterTerms({ clientName: r.full_name, address: r.address, body: r.body, templateBody, names, facts: [r.reason, r.account_status, r.payment_status] }),
    specificity: await specificityInputFor(db, letterId),
    comparable: comparable({ body: r.body, full_name: r.full_name, address: r.address, names, reason: r.reason, templateBody }),
  };
}

/** How many recent letters the overlap check reads, and how far back. */
export const OVERLAP_LETTERS = 30;
export const OVERLAP_DAYS = 180;

/**
 * The wording of the agency's recent letters for OTHER clients, newest first. Each letter's own names, reason and
 * numbers are taken out first, so what is compared is wording, standard paragraphs included. Worked out here from the
 * stored text: no AI, and nothing leaves the server.
 */
export async function recentOtherWording(db: Db, clientId: string, limit = OVERLAP_LETTERS): Promise<string[]> {
  const rows = await db.rows<{ body: string; template_key: string | null; full_name: string; address: Address; recipient_name: string; item_label: string | null; reason: string | null; creditor_name: string | null }>(
    `select v.body, l.template_key, c.full_name, c.address, l.recipient_name, d.item_label, d.reason, t.creditor_name
       from public.letters l join public.clients c on c.id = l.client_id
       join public.letter_versions v on v.letter_id = l.id and v.version = l.current_version
       left join public.disputes d on d.id = l.dispute_id left join public.tradelines t on t.id = d.tradeline_id
      where l.client_id <> $1 and l.status <> 'void' and l.created_at > now() - make_interval(days => $3::int)
      order by l.created_at desc limit $2`, [clientId, limit, OVERLAP_DAYS]);
  return rows.map((r) => comparable({ body: r.body, full_name: r.full_name, address: r.address, names: [r.recipient_name, r.creditor_name, r.item_label], reason: r.reason, templateBody: templateByKey(r.template_key ?? '')?.body })).filter(Boolean);
}

/** The overlap shown beside a letter: its wording against other clients' recent letters. Null when there is nothing to compare. */
export async function letterOverlap(db: Db, subject: Pick<TailorSubject, 'clientId' | 'comparable'>): Promise<WordingOverlap | null> {
  return wordingOverlap(subject.comparable, await recentOtherWording(db, subject.clientId));
}

// ---------------------------------------------------------------- the agency's optional setting

/** organizations.settings key. Absent or false = off: tailoring stays a button on the letter. */
export const AUTO_TAILOR_SETTING = 'letter_auto_tailor';

export async function autoTailorOn(db: Db, orgId: string): Promise<boolean> {
  return (await db.row<{ on: boolean | null }>(`select settings->>'${AUTO_TAILOR_SETTING}' = 'true' as on from public.organizations where id = $1`, [orgId]))?.on === true;
}

export async function setAutoTailor(db: Db, orgId: string, on: boolean): Promise<void> {
  await db.run(`update public.organizations set settings = settings || jsonb_build_object('${AUTO_TAILOR_SETTING}', $2::boolean) where id = $1`, [orgId, on]);
}

/**
 *   off        the setting is off, or no AI provider is connected: nothing was done
 *   applied    a tailored wording passed every check, was paid for, and is now the draft's current version
 *   unchanged  the draft keeps its standard wording (no credits, nothing safe returned, or the letter is not a draft)
 */
export type AutoTailor = 'off' | 'applied' | 'unchanged';

/**
 * "Tailor wording automatically when a letter is drafted": run after a draft has been created and committed, never
 * inside its transaction (the model call can take seconds). With the setting on, the draft goes through the same
 * tailoring and the same checks as the button, is charged the same way, and a safe result is saved as a new DRAFT
 * version marked as AI wording. The letter still has to be read, sent for approval and approved by a person; nothing
 * here approves or sends. It never throws: a draft that could not be tailored is simply left as it was.
 */
export async function autoTailorDraft(actor: LActor, letterId: string, tx: Tx, provider: AiProvider | null = getProvider()): Promise<AutoTailor> {
  try {
    if (!provider || !(await tx((db) => autoTailorOn(db, actor.orgId)))) return 'off';
    const s = await tx((db) => loadTailorSubject(db, letterId));
    if (!s || s.status !== 'draft') return 'unchanged';
    const out = await suggestForLetter({ orgId: actor.orgId, userId: actor.userId, letterId, version: s.version, body: s.body, protectedTerms: s.protectedTerms, seed: s.seed, specificity: s.specificity }, tx, provider);
    if (!out.ok) return 'unchanged';
    return await tx(async (db) => {
      const cur = await currentBody(db, letterId);
      if (!cur || cur.version !== s.version || tailorIssue(cur.body, out.text, s)) return 'unchanged';
      await saveVersion(db, actor, letterId, out.text, 'ai_draft', `AI wording applied when the letter was drafted (${out.provider})`);
      return 'applied';
    });
  } catch (e) {
    console.error('[letters] automatic wording step failed for letter', letterId, (e as Error).message);
    return 'unchanged';
  }
}
