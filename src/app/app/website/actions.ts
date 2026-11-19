'use server';

import { revalidatePath } from 'next/cache';
import type { ActionState } from '@/components/forms';
import { run, UserError } from '@/lib/action';
import { parseSite, saveSite, SITE_LIMITS, sitePath, unpublishSite, type SiteContent } from '@/lib/agency-site';
import { audit } from '@/lib/audit';
import { requireStaff, type Ctx } from '@/lib/auth/context';
import type { Db } from '@/lib/db';

const text = (fd: FormData, k: string) => { const v = fd.get(k); return typeof v === 'string' ? v : ''; };
const ROWS = Array.from({ length: SITE_LIMITS.items }, (_, i) => i + 1);

async function stored(db: Db, ctx: Ctx): Promise<{ slug: string; site: SiteContent }> {
  const org = await db.row<{ slug: string; mode: string; settings: Record<string, unknown> | null }>('select slug, mode, settings from public.organizations where id = $1', [ctx.orgId]);
  if (!org || org.mode !== 'agency') throw new UserError('A website is for agency workspaces.');
  return { slug: org.slug, site: parseSite(org.settings) };
}

/** Saves the text of the site. Whether it is published is a separate switch and is left as it is. */
export async function saveSiteAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('settings:manage');
  return run(async () => {
    const draft = {
      headline: text(fd, 'headline'), intro: text(fd, 'intro'), about: text(fd, 'about'),
      phone: text(fd, 'phone'), email: text(fd, 'email'), hours: text(fd, 'hours'), area: text(fd, 'area'),
      // Rows left completely empty are dropped; a half-filled row is reported by the schema with its number.
      services: ROWS.map((i) => ({ title: text(fd, `svcTitle${i}`), text: text(fd, `svcText${i}`) })).filter((s) => s.title.trim() || s.text.trim()),
      faqs: ROWS.map((i) => ({ q: text(fd, `faqQ${i}`), a: text(fd, `faqA${i}`) })).filter((f) => f.q.trim() || f.a.trim()),
    };
    const { slug, published } = await ctx.tx(async (db) => {
      const cur = await stored(db, ctx);
      const site = await saveSite(db, ctx.orgId, { ...draft, published: cur.site.published });
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'org.website_saved', entityType: 'organization', entityId: ctx.orgId, ip: ctx.meta.ip, meta: { published: site.published } });
      return { slug: cur.slug, published: site.published };
    });
    revalidatePath('/app/website');
    revalidatePath(sitePath(slug));
    return { ok: published ? 'Saved. Your site shows the new text now.' : 'Saved. Your site is not published yet.' };
  });
}

/** Publishes or unpublishes the saved site. Publishing re-checks the saved text, so nothing that fails the claims check goes live. */
export async function setSitePublishedAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('settings:manage');
  const on = fd.get('on') === 'true';
  return run(async () => {
    const slug = await ctx.tx(async (db) => {
      const cur = await stored(db, ctx);
      // Unpublishing is a direct write that checks nothing, so it always works. Publishing re-checks the saved text and the business name.
      if (on) await saveSite(db, ctx.orgId, { ...cur.site, published: true });
      else await unpublishSite(db, ctx.orgId);
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: on ? 'org.website_published' : 'org.website_unpublished', entityType: 'organization', entityId: ctx.orgId, ip: ctx.meta.ip });
      return cur.slug;
    });
    revalidatePath('/app/website');
    revalidatePath('/app/leads');
    revalidatePath(sitePath(slug));
    return { ok: on ? 'Your site is published.' : 'Your site is unpublished. Its address now shows “page not found”.' };
  });
}
