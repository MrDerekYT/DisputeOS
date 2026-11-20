import { z } from 'zod';
import { auditSystem } from './audit';
import { rateLimit } from './auth/rate-limit';
import { withSystem } from './db';
import { DEFAULT_LEAD_SOURCE, leadSourceTag } from './lead-emails';
import { leadTextsOffered, recordEnquirySmsConsent, runLeadOutreach, runLeadTexts } from './lead-outreach';
import { LEAD_SMS_NEEDS_PHONE } from './lead-texts';
import { orgBrandBySlug } from './org-brand';
import { APPROVAL_COLS, type ApprovalRow } from './outreach-approval';
import { toUsE164 } from './sms';

/** What people usually want better credit for. A goal is context for the specialist — never a promise of approval. */
export const LEAD_GOALS = { home: 'Buying a home', car: 'Getting a car', card: 'Qualifying for a credit card', rent: 'Renting an apartment', rates: 'Lower interest rates', business: 'Starting a business', other: 'Something else' } as const;
export type LeadGoal = keyof typeof LEAD_GOALS;

/** What a prospective client may send through an agency's public enquiry form. No SSN, DOB or account data is accepted here. */
export const leadSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter your name').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(200),
  phone: z.string().trim().max(30).optional().or(z.literal('')),
  message: z.string().trim().max(1000).optional().or(z.literal('')),
  goal: z.enum(Object.keys(LEAD_GOALS) as [LeadGoal, ...LeadGoal[]]).optional(),
  language: z.enum(['en', 'es']).default('en'),
  consent: z.literal(true, { error: 'Please confirm we may contact you' }),
  /** The separate, optional text-message box. Unticked unless the person ticks it; never implied by `consent`. */
  smsConsent: z.boolean().optional(),
});
export type LeadInput = z.infer<typeof leadSchema>;

export type LeadResult = { ok: true } | { ok: false; error: string };

/**
 * Records an enquiry as a client with status "lead" and a follow-up task for the team.
 * - Only active agency workspaces accept enquiries (same rule as the branded sign-in page).
 * - Rate limited per IP and per agency; a filled honeypot is accepted silently and discarded.
 * - `meta.src` is the `?src=` tag from the link the person followed (instagram, flyer, …); it is stored as the lead's source.
 * - When the agency has switched automatic follow-up on, a new lead gets the welcome email straight away — but never
 *   inside the request: it is handed to `meta.defer` (the form passes Next's `after`), so an enquiry from a new address
 *   and one from an address already on file answer in the same time. If it is lost, the scheduled job sends it.
 * - If the email already belongs to someone on file, nothing new is created and the reply is identical,
 *   so the form cannot be used to find out who is a client.
 * - Text messages: when the agency offers text follow-up (switched on, and the workspace approved for outreach by the
 *   platform operator), the form shows a second, unticked box. Ticking it records an SMS consent for the number
 *   entered, which has to be a US number, with the wording shown in `meta.shownIn` (recordEnquirySmsConsent). Without
 *   it no text is ever sent to the lead; the emails are unaffected.
 */
export async function submitLead(slug: string, raw: unknown, meta: {
  ip?: string | null; userAgent?: string | null; honeypot?: string | null; src?: string | null;
  /** The language the form was shown in (the consent wording the person saw), which may differ from their preferred language. */
  shownIn?: 'en' | 'es';
  defer?: (task: () => Promise<void>) => void;
} = {}): Promise<LeadResult> {
  const brand = await orgBrandBySlug(slug);
  if (!brand) return { ok: false, error: 'This form is not available.' };
  if (meta.honeypot) return { ok: true };
  const parsed = leadSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Please check the form.' };
  const d = parsed.data;
  // Checked before anything is looked up, so the answer is the same whether or not the email address is on file. Only
  // a US number can be texted: the form is public, and it must not be a way to text any number in the world.
  if (d.smsConsent && !toUsE164(d.phone)) return { ok: false, error: LEAD_SMS_NEEDS_PHONE[meta.shownIn === 'es' ? 'es' : 'en'] };
  // The address's own limit first: a request it refuses is not counted against the agency, so one address posting
  // over and over cannot use up the agency's hourly allowance and close its form for every other visitor.
  const tooMany: LeadResult = { ok: false, error: 'Too many requests. Please try again later.' };
  if (!(await rateLimit(`lead:ip:${meta.ip ?? 'unknown'}`, 5, 3600)).allowed) return tooMany;
  if (!(await rateLimit(`lead:org:${slug}`, 60, 3600)).allowed) return tooMany;

  const created = await withSystem(async (db) => {
    const org = await db.row<ApprovalRow & { id: string; settings: Record<string, unknown> }>(`select id, ${APPROVAL_COLS}, settings from public.organizations where slug = $1 and status = 'active' and mode = 'agency'`, [slug]);
    if (!org) return null;
    const dup = await db.row<{ id: string }>('select id from public.clients where org_id = $1 and email = $2 limit 1', [org.id, d.email]);
    if (dup) {
      await db.run("insert into public.client_events (org_id, client_id, kind, summary) values ($1, $2, 'lead_repeat', 'Sent the website enquiry form again')", [org.id, dup.id]);
      return { orgId: org.id, clientId: dup.id, isNew: false };
    }
    const c = await db.row<{ id: string }>(
      `insert into public.clients (org_id, full_name, email, phone, preferred_language, status, stage, source, goals)
       values ($1, $2, $3, $4, $5, 'lead', 'intake', $7, $6) returning id`,
      [org.id, d.fullName, d.email, d.phone || null, d.language, [d.goal ? `Goal: ${LEAD_GOALS[d.goal]}.` : '', d.message || ''].filter(Boolean).join(' ') || null, leadSourceTag(meta.src) ?? DEFAULT_LEAD_SOURCE]);
    await db.run("insert into public.client_events (org_id, client_id, kind, summary, meta) values ($1, $2, 'lead_created', 'Enquiry received from the website form', $3)",
      [org.id, c!.id, JSON.stringify({ contact_consent: true })]);
    // The text-message box is a separate consent. It is recorded only when the agency offers texts (the box was shown).
    if (d.smsConsent && leadTextsOffered(org)) {
      await recordEnquirySmsConsent(db, { orgId: org.id, clientId: c!.id, orgName: org.name, phone: d.phone, lang: meta.shownIn === 'es' ? 'es' : 'en', ip: meta.ip, userAgent: meta.userAgent });
    }
    await db.run(
      `insert into public.tasks (org_id, client_id, title, detail, kind, due_at, source, dedupe_key)
       values ($1, $2, $3, $4, 'follow_up', now() + interval '1 day', 'automation', $5)`,
      [org.id, c!.id, `Contact new lead: ${d.fullName}`.slice(0, 200), 'Came in through your website enquiry form. They agreed to be contacted about your services.', `lead:${c!.id}`]);
    return { orgId: org.id, clientId: c!.id, isNew: true };
  });
  if (!created) return { ok: false, error: 'This form is not available.' };
  if (created.isNew) {
    await auditSystem({ orgId: created.orgId, actorLabel: 'Website enquiry form', action: 'lead.created', entityType: 'client', entityId: created.clientId, ip: meta.ip ?? undefined });
    const welcome = async () => {
      await runLeadOutreach(created.orgId, { clientId: created.clientId }).then(() => undefined, (e) => console.error('[leads] welcome email failed', created.clientId, (e as Error).message));
      // The welcome text, for a lead who ticked the text-message box (held until morning when it is night where they are).
      await runLeadTexts(created.orgId, { clientId: created.clientId }).then(() => undefined, (e) => console.error('[leads] welcome text failed', created.clientId, (e as Error).message));
    };
    // Never awaited here: waiting on the email service would make the response time reveal whether the address was new.
    if (meta.defer) meta.defer(welcome); else void welcome();
  }
  return { ok: true };
}

export const leadFormPath = (slug: string, src?: string | null) => `/start/${encodeURIComponent(slug)}${src ? `?src=${encodeURIComponent(src)}` : ''}`;
