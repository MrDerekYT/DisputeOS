/**
 * "For you right now": up to three steps taken from the asker's OWN records.
 * Both loaders must run inside the caller's tenant transaction, so PostgreSQL row-level security decides what is
 * visible: a portal user reaches only their own client record; staff reach only clients their role can see.
 * Nothing here is estimated or invented — every step corresponds to a row that exists.
 *
 * The portal steps read the agreements the way the portal home does (src/lib/onboarding.ts, loadWelcome): what the
 * welcome steps ask now, and whether the client cancelled their service agreement. The staff steps are the client's
 * action plan (src/lib/plan.ts), whose missing consents are those the server's gate requires (loadServiceStatus).
 */
import { decryptPII } from '../crypto';
import type { Db } from '../db';
import { loadWelcome, type WelcomeAsk } from '../onboarding';
import { buildPlan, loadPlanInput } from '../plan';
import { fill, tr, type Lang, type PortalKey } from '../portal-i18n';
import { nextStep, type NextKey } from '../portal-next-step';
import { fmtDate } from '../util';
import type { Redaction } from './llm';

export const MAX_GUIDE_STEPS = 3;

export interface GuideStep { key: string; title: string; detail: string; href?: string }

export interface PersonalSteps {
  steps: GuideStep[];
  /** Names that must never be sent to an AI provider (the person's name, creditor names from their reports). */
  redact: string[];
  /**
   * What the app holds about the person that must never be sent either (clientIdentifiers): the address lines, city and
   * ZIP code, the SSN last four and the date of birth in common formats. It stays on the server: only the masked
   * question is sent, and the reply carries the steps, never this.
   */
  identifiers?: Redaction[];
}

const NONE: PersonalSteps = { steps: [], redact: [] };
const nameParts = (full: string) => full.split(/\s+/).filter((p) => p.length >= 2);

/** The identifying fields of a client's record, as stored; the date of birth decrypted, as YYYY-MM-DD. */
export interface ClientIdentity {
  address?: { line1?: string; line2?: string; city?: string; state?: string; zip?: string } | null;
  ssn_last4?: string | null;
  dob?: string | null;
}

const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const ordinal = (d: number) => (d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th');

/** The common ways to write a day: 1985-03-14, 03/14/1985, 3/14/85, 14/03/1985, 14.03.1985, March 14, 1985, 14 March 1985, 14 de marzo de 1985… */
function dayForms(day: string): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return [];
  const [, y, mm, dd] = m as unknown as [string, string, string, string];
  const mo = Number(mm);
  const d = Number(dd);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return [];
  const forms = new Set([`${y}-${mm}-${dd}`, `${y}/${mm}/${dd}`, `${mm}${dd}${y}`, `${y}${mm}${dd}`]);
  for (const sep of ['/', '-', '.']) {
    for (const year of [y, y.slice(2)]) for (const [a, b] of [[mm, dd], [String(mo), String(d)], [dd, mm], [String(d), String(mo)]] as const) forms.add([a, b, year].join(sep));
  }
  const month = MONTHS_EN[mo - 1]!;
  for (const name of [month, month.slice(0, 3), `${month.slice(0, 3)}.`]) {
    for (const n of [`${d}`, `${d}${ordinal(d)}`]) {
      for (const f of [`${name} ${n}, ${y}`, `${name} ${n} ${y}`, `${name} ${n}`, `${n} ${name} ${y}`, `${n} ${name}, ${y}`, `${n} ${name}`, `${n} of ${name}`, `${n} of ${name}, ${y}`]) forms.add(f);
    }
  }
  const mes = MONTHS_ES[mo - 1]!;
  for (const f of [`${d} de ${mes} de ${y}`, `${d} de ${mes} del ${y}`, `${d} de ${mes}`, `${mes} ${d}, ${y}`]) forms.add(f);
  return [...forms];
}

/**
 * What the app holds about a client that identifies them, as the guide masks it in a typed question: the address's
 * first and second lines, city and ZIP code (both the full ZIP+4 and its five digits), the SSN last four, and the date
 * of birth in common formats. The state is left out: on its own it identifies nobody, and its codes are common words
 * ("IN", "OR", "ME"). So is anything shorter than 3 characters, which would mask ordinary words.
 */
export function clientIdentifiers(c: ClientIdentity): Redaction[] {
  const out: Redaction[] = [];
  const clean = (s: unknown) => (typeof s === 'string' ? s.trim().replace(/[.,;:]+$/, '') : '');
  const a = c.address ?? {};
  for (const part of [a.line1, a.line2, a.city]) { const t = clean(part); if (t.length >= 3) out.push({ text: t, as: 'ADDRESS' }); }
  const zip = clean(a.zip);
  if (zip.length >= 3) out.push({ text: zip, as: 'ADDRESS' });
  const zip5 = /^(\d{5})-?\d{4}$/.exec(zip)?.[1];
  if (zip5) out.push({ text: zip5, as: 'ADDRESS' });
  const last4 = clean(c.ssn_last4);
  if (/^\d{4}$/.test(last4)) out.push({ text: last4, as: 'SSN' });
  if (c.dob) for (const f of dayForms(c.dob)) out.push({ text: f, as: 'DATE' });
  return out;
}

/** The date of birth on file as YYYY-MM-DD, or null when there is none or it cannot be read. */
function storedDay(encrypted: string | null): string | null {
  if (!encrypted) return null;
  try {
    const day = decryptPII(encrypted).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  } catch {
    return null;
  }
}

interface ClientRow { full_name: string; address: ClientIdentity['address']; ssn_last4: string | null; dob_encrypted: string | null }
const identifiersOf = (c: ClientRow) => clientIdentifiers({ address: c.address, ssn_last4: c.ssn_last4, dob: storedDay(c.dob_encrypted) });

const PORTAL_HREF: Record<NextKey, string> = {
  sign: '/portal/welcome?step=agreements', upload: '/portal#needs', intake: '/portal/documents#checklist', review: '/portal/disputes', wait: '/portal/disputes', prep: '/portal', done: '/portal',
};
const SIGN_HREF = '/portal/welcome?step=agreements';

export interface PortalStepInput {
  /** What the welcome steps ask of the client now (src/lib/onboarding.ts, Onboarding.ask), or null. */
  ask: WelcomeAsk | null;
  /** The day the client cancelled their service agreement in the portal, while none is in force since (Onboarding.agreements.cancelledOn). */
  cancelledOn?: string | null;
  /** The agency's name, for the steps that name it. */
  org?: string;
  needDocs: boolean; reviewing: boolean; nextDue: string | null; stage: string;
}

/** A day as the portal home writes it in a sentence: "November 20, 2026", "20 de noviembre de 2026". */
const longDay = (day: string, lang: Lang) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/**
 * The step for what the welcome steps ask, in the words and with the link the portal home uses for it
 * (src/app/portal/welcome-ask.ts, welcomeAskCopy; tests/unit/guide.test.ts keeps the two the same):
 *  - "We can't start work until your agreements are signed" only while a document the service needs is not in force;
 *  - otherwise the consent to electronic records, or the current version of the statement, in gentler words;
 *  - while the agency finishes its service agreement, a step that is the agency's to do, with nothing to click.
 * `mine`: the client has something to do.
 */
function askStep(ask: WelcomeAsk, t: (k: PortalKey) => string, org: string): { step: GuideStep; mine: boolean } {
  switch (ask.step) {
    case 'details': return { mine: true, step: { key: 'welcome', title: t('wl_hero_t'), detail: t('wl_hero_b'), href: '/portal/welcome' } };
    case 'agreements': {
      const [key, words] = ask.needed ? ['sign', 'ns_sign'] : ask.next === 'esign' ? ['esign', 'ns_esign'] : ['update', 'ns_update'];
      return { mine: true, step: { key, title: t(`${words}_t` as PortalKey), detail: t(`${words}_b` as PortalKey), href: SIGN_HREF } };
    }
    case 'documents': return { mine: true, step: { key: 'intake', title: t('ns_intake_t'), detail: t('ns_intake_b'), href: '/portal/welcome?step=documents' } };
    case 'waiting': return { mine: false, step: { key: 'prepAg', title: t('ns_prepAg_t'), detail: fill(t('ns_prepAg_b'), { org }) } };
  }
}

/**
 * Pure: every step that applies to the client, in the client's language: what the client has to do first, then what
 * the agency or the bureaus are doing. As on the portal home (src/lib/portal-next-step.ts, portalHero), a client who
 * cancelled their service agreement is shown that, and is not asked to sign it again.
 */
export function portalSteps(x: PortalStepInput, lang: Lang): GuideStep[] {
  const t = tr(lang);
  const org = x.org ?? '';
  const status = (key: NextKey): GuideStep => ({
    key,
    title: t(`ns_${key}_t` as PortalKey),
    detail: key === 'wait' ? `${t('ns_wait_b')} ${fmtDate(x.nextDue, lang)}.` : t(`ns_${key}_b` as PortalKey),
    href: PORTAL_HREF[key],
  });
  const ask = x.ask && !x.cancelledOn ? askStep(x.ask, t, org) : null;
  const steps: GuideStep[] = [];
  if (x.cancelledOn) steps.push({ key: 'cancelled', title: t('cx_done_t'), detail: fill(t('cx_done_b'), { date: longDay(x.cancelledOn, lang), org }), href: '/portal/profile#agreements' });
  if (ask?.mine) steps.push(ask.step);
  if (x.needDocs) steps.push(status('upload'));
  if (ask && !ask.mine) steps.push(ask.step);
  if (x.reviewing) steps.push(status('review'));
  if (x.nextDue) steps.push(status('wait'));
  if (steps.length === 0) steps.push(status(nextStep({ needSign: false, needDocs: false, reviewing: false, nextDue: null, stage: x.stage }).key));
  return steps.slice(0, MAX_GUIDE_STEPS);
}

/** Portal: the signed-in client's own steps. Returns nothing when `clientId` is not a record this session can read. */
export async function loadPortalSteps(db: Db, clientId: string, lang: Lang): Promise<PersonalSteps> {
  const client = await db.row<ClientRow & { stage: string }>('select full_name, stage, address, ssn_last4, dob_encrypted from public.clients where id = $1', [clientId]);
  if (!client) return NONE;
  // The agreements as the portal home reads them: the same records, the same signing order and the same asks.
  const welcome = await loadWelcome(db, clientId);
  const requests = await db.row<{ n: number }>('select count(*)::int as n from public.document_requests where client_id = $1 and fulfilled_document_id is null', [clientId]);
  const d = await db.row<{ reviewing: number; next_due: string | null }>(
    `select count(*) filter (where status = 'response_received')::int as reviewing,
            min(due_at) filter (where status in ('submitted','under_investigation')) as next_due
       from public.disputes where client_id = $1`, [clientId]);
  const steps = portalSteps({
    ask: welcome?.ob.ask ?? null, cancelledOn: welcome?.ob.agreements.cancelledOn ?? null, org: welcome?.ag.agency.agencyName ?? '',
    needDocs: (requests?.n ?? 0) > 0, reviewing: (d?.reviewing ?? 0) > 0, nextDue: d?.next_due ?? null, stage: client.stage,
  }, lang);
  return { steps, redact: nameParts(client.full_name), identifiers: identifiersOf(client) };
}

/** Staff: the first steps of the action plan of the client being viewed — if this session can see that client. */
export async function loadStaffSteps(db: Db, clientId: string, self: boolean): Promise<PersonalSteps> {
  const client = await db.row<ClientRow>('select full_name, address, ssn_last4, dob_encrypted from public.clients where id = $1', [clientId]);
  if (!client) return NONE;
  const input = await loadPlanInput(db, clientId);
  const first = client.full_name.split(' ')[0] ?? '';
  const steps = buildPlan({ ...input, firstName: first, self }).slice(0, MAX_GUIDE_STEPS).map(({ key, title, detail, href }) => ({ key, title, detail, href }));
  return { steps, redact: [...nameParts(client.full_name), ...input.collections, ...input.accounts.map((a) => a.creditor)], identifiers: identifiersOf(client) };
}

/**
 * What an AI provider is told about a step: a fixed, generic label chosen by the step's key. The real title and
 * detail (which can carry a first name, creditor names, balances or dates) never leave the server.
 */
const GENERIC_LABEL: Record<string, string> = {
  sign: 'Sign the required agreements', esign: 'Confirm how documents are delivered', update: 'Read the current statement of rights',
  welcome: 'Finish setting up the file', intake: 'Upload the identity documents', prepAg: 'The agency is preparing its agreement', cancelled: 'The service agreement was cancelled',
  upload: 'Upload the requested documents', review: 'A reply is being reviewed', wait: 'An investigation is under way',
  prep: 'The file is being prepared', done: 'Nothing is waiting right now',
  'get-reports': 'Get the free credit reports', 'review-reports': 'Check the imported reports', consents: 'Collect the required consents', findings: 'Review the findings',
  collections: 'Look at the collection accounts', 'card-usage': 'Look at card usage', 'follow-up': 'Follow up on a dispute', 'send-letters': 'Send the approved letters', 'caught-up': 'Nothing is waiting right now',
};

export const genericStepLabels = (steps: GuideStep[]): string[] => steps.map((s) => GENERIC_LABEL[s.key]).filter((l): l is string => !!l);
