/**
 * "For you right now": up to three steps taken from the asker's OWN records.
 * Both loaders must run inside the caller's tenant transaction, so PostgreSQL row-level security decides what is
 * visible: a portal user reaches only their own client record; staff reach only clients their role can see.
 * Nothing here is estimated or invented — every step corresponds to a row that exists.
 */
import { REQUIRED_CONSENTS } from '../compliance/disclosures';
import type { Db } from '../db';
import { buildPlan, loadPlanInput } from '../plan';
import { tr, type Lang, type PortalKey } from '../portal-i18n';
import { nextStep, type NextKey } from '../portal-next-step';
import { fmtDate } from '../util';

export const MAX_GUIDE_STEPS = 3;

export interface GuideStep { key: string; title: string; detail: string; href?: string }

export interface PersonalSteps {
  steps: GuideStep[];
  /** Names that must never be sent to an AI provider (the person's name, creditor names from their reports). */
  redact: string[];
}

const NONE: PersonalSteps = { steps: [], redact: [] };
const nameParts = (full: string) => full.split(/\s+/).filter((p) => p.length >= 2);

const PORTAL_HREF: Record<NextKey, string> = {
  sign: '/portal/profile#agreements', upload: '/portal#needs', review: '/portal/disputes', wait: '/portal/disputes', prep: '/portal', done: '/portal',
};

export interface PortalStepInput { needSign: boolean; needDocs: boolean; reviewing: boolean; nextDue: string | null; stage: string }

/** Pure: every step that applies to the client, most urgent first, in the client's language. */
export function portalSteps(x: PortalStepInput, lang: Lang): GuideStep[] {
  const t = tr(lang);
  const keys: NextKey[] = [];
  if (x.needSign) keys.push('sign');
  if (x.needDocs) keys.push('upload');
  if (x.reviewing) keys.push('review');
  if (x.nextDue) keys.push('wait');
  if (keys.length === 0) keys.push(nextStep(x).key);
  return keys.slice(0, MAX_GUIDE_STEPS).map((key) => ({
    key,
    title: t(`ns_${key}_t` as PortalKey),
    detail: key === 'wait' ? `${t('ns_wait_b')} ${fmtDate(x.nextDue, lang)}.` : t(`ns_${key}_b` as PortalKey),
    href: PORTAL_HREF[key],
  }));
}

/** Portal: the signed-in client's own steps. Returns nothing when `clientId` is not a record this session can read. */
export async function loadPortalSteps(db: Db, clientId: string, lang: Lang): Promise<PersonalSteps> {
  const client = await db.row<{ full_name: string; stage: string }>('select full_name, stage from public.clients where id = $1', [clientId]);
  if (!client) return NONE;
  const consents = await db.rows<{ kind: string }>('select kind from public.client_consents where client_id = $1 and revoked_at is null', [clientId]);
  const requests = await db.row<{ n: number }>('select count(*)::int as n from public.document_requests where client_id = $1 and fulfilled_document_id is null', [clientId]);
  const d = await db.row<{ reviewing: number; next_due: string | null }>(
    `select count(*) filter (where status = 'response_received')::int as reviewing,
            min(due_at) filter (where status in ('submitted','under_investigation')) as next_due
       from public.disputes where client_id = $1`, [clientId]);
  const steps = portalSteps({
    needSign: REQUIRED_CONSENTS.some((k) => !consents.some((c) => c.kind === k)),
    needDocs: (requests?.n ?? 0) > 0, reviewing: (d?.reviewing ?? 0) > 0, nextDue: d?.next_due ?? null, stage: client.stage,
  }, lang);
  return { steps, redact: nameParts(client.full_name) };
}

/** Staff: the first steps of the action plan of the client being viewed — if this session can see that client. */
export async function loadStaffSteps(db: Db, clientId: string, self: boolean): Promise<PersonalSteps> {
  const client = await db.row<{ full_name: string }>('select full_name from public.clients where id = $1', [clientId]);
  if (!client) return NONE;
  const input = await loadPlanInput(db, clientId);
  const first = client.full_name.split(' ')[0] ?? '';
  const steps = buildPlan({ ...input, firstName: first, self }).slice(0, MAX_GUIDE_STEPS).map(({ key, title, detail, href }) => ({ key, title, detail, href }));
  return { steps, redact: [...nameParts(client.full_name), ...input.collections, ...input.accounts.map((a) => a.creditor)] };
}

/**
 * What an AI provider is told about a step: a fixed, generic label chosen by the step's key. The real title and
 * detail (which can carry a first name, creditor names, balances or dates) never leave the server.
 */
const GENERIC_LABEL: Record<string, string> = {
  sign: 'Sign the required agreements', upload: 'Upload the requested documents', review: 'A reply is being reviewed', wait: 'An investigation is under way',
  prep: 'The file is being prepared', done: 'Nothing is waiting right now',
  'get-reports': 'Get the free credit reports', 'review-reports': 'Check the imported reports', consents: 'Collect the required consents', findings: 'Review the findings',
  collections: 'Look at the collection accounts', 'card-usage': 'Look at card usage', 'follow-up': 'Follow up on a dispute', 'send-letters': 'Send the approved letters', 'caught-up': 'Nothing is waiting right now',
};

export const genericStepLabels = (steps: GuideStep[]): string[] => steps.map((s) => GENERIC_LABEL[s.key]).filter((l): l is string => !!l);
