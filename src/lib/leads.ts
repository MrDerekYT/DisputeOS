import { z } from 'zod';
import { auditSystem } from './audit';
import { rateLimit } from './auth/rate-limit';
import { withSystem } from './db';
import { orgBrandBySlug } from './org-brand';

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
});
export type LeadInput = z.infer<typeof leadSchema>;

export type LeadResult = { ok: true } | { ok: false; error: string };

/**
 * Records an enquiry as a client with status "lead" and a follow-up task for the team.
 * - Only active agency workspaces accept enquiries (same rule as the branded sign-in page).
 * - Rate limited per IP and per agency; a filled honeypot is accepted silently and discarded.
 * - If the email already belongs to someone on file, nothing new is created and the reply is identical,
 *   so the form cannot be used to find out who is a client.
 */
export async function submitLead(slug: string, raw: unknown, meta: { ip?: string | null; honeypot?: string | null } = {}): Promise<LeadResult> {
  const brand = await orgBrandBySlug(slug);
  if (!brand) return { ok: false, error: 'This form is not available.' };
  if (meta.honeypot) return { ok: true };
  const parsed = leadSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Please check the form.' };
  const d = parsed.data;
  const ipLimit = await rateLimit(`lead:ip:${meta.ip ?? 'unknown'}`, 5, 3600);
  const orgLimit = await rateLimit(`lead:org:${slug}`, 60, 3600);
  if (!ipLimit.allowed || !orgLimit.allowed) return { ok: false, error: 'Too many requests. Please try again later.' };

  const created = await withSystem(async (db) => {
    const org = await db.row<{ id: string }>("select id from public.organizations where slug = $1 and status = 'active' and mode = 'agency'", [slug]);
    if (!org) return null;
    const dup = await db.row<{ id: string }>('select id from public.clients where org_id = $1 and email = $2 limit 1', [org.id, d.email]);
    if (dup) {
      await db.run("insert into public.client_events (org_id, client_id, kind, summary) values ($1, $2, 'lead_repeat', 'Sent the website enquiry form again')", [org.id, dup.id]);
      return { orgId: org.id, clientId: dup.id, isNew: false };
    }
    const c = await db.row<{ id: string }>(
      `insert into public.clients (org_id, full_name, email, phone, preferred_language, status, stage, source, goals)
       values ($1, $2, $3, $4, $5, 'lead', 'intake', 'Website form', $6) returning id`,
      [org.id, d.fullName, d.email, d.phone || null, d.language, [d.goal ? `Goal: ${LEAD_GOALS[d.goal]}.` : '', d.message || ''].filter(Boolean).join(' ') || null]);
    await db.run("insert into public.client_events (org_id, client_id, kind, summary, meta) values ($1, $2, 'lead_created', 'Enquiry received from the website form', $3)",
      [org.id, c!.id, JSON.stringify({ contact_consent: true })]);
    await db.run(
      `insert into public.tasks (org_id, client_id, title, detail, kind, due_at, source, dedupe_key)
       values ($1, $2, $3, $4, 'follow_up', now() + interval '1 day', 'automation', $5)`,
      [org.id, c!.id, `Contact new lead: ${d.fullName}`.slice(0, 200), 'Came in through your website enquiry form. They agreed to be contacted about your services.', `lead:${c!.id}`]);
    return { orgId: org.id, clientId: c!.id, isNew: true };
  });
  if (!created) return { ok: false, error: 'This form is not available.' };
  if (created.isNew) await auditSystem({ orgId: created.orgId, actorLabel: 'Website enquiry form', action: 'lead.created', entityType: 'client', entityId: created.clientId, ip: meta.ip ?? undefined });
  return { ok: true };
}

export const leadFormPath = (slug: string) => `/start/${encodeURIComponent(slug)}`;
