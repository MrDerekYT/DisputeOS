import Link from 'next/link';
import type { Metadata } from 'next';
import { ActionForm, Field, SubmitButton, TextArea } from '@/components/forms';
import { CopyButton } from '@/components/shell-client';
import { ShareLink } from '@/components/staff-kit';
import { Badge, Notice, PageHeader, Section } from '@/components/ui';
import { parseSite, SITE_LIMITS as L, sitePath, starterSite } from '@/lib/agency-site';
import { requireStaff } from '@/lib/auth/context';
import { getEnv } from '@/lib/env';
import { outreachSettings } from '@/lib/lead-outreach';
import { saveSiteAction, setSitePublishedAction } from './actions';
import { DomainSection } from './domain-section';

export const metadata: Metadata = { title: 'Website' };
const ROWS = Array.from({ length: L.items }, (_, i) => i);

/** The editor for the agency's hosted website (/a/<slug>). Plain text only; every save goes through the claims check. */
export default async function WebsitePage({ searchParams }: { searchParams: Promise<{ starter?: string }> }) {
  const ctx = await requireStaff('settings:manage');
  const org = (await ctx.tx((db) => db.row<{ name: string; slug: string; mode: string; settings: Record<string, unknown> | null }>('select name, slug, mode, settings from public.organizations where id = $1', [ctx.orgId])))!;
  if (org.mode !== 'agency') {
    return (
      <>
        <PageHeader title="Website" />
        <Notice title="A website is for agency workspaces">This is a personal workspace, so it has no public website.</Notice>
      </>
    );
  }
  const saved = parseSite(org.settings);
  // "Load starter text" fills only what is still empty, and only in the form: nothing is stored until Save.
  const starter = (await searchParams).starter === '1';
  const draft = starterSite(org.name);
  const c = !starter ? saved : {
    ...saved,
    headline: saved.headline || draft.headline, intro: saved.intro || draft.intro, about: saved.about || draft.about,
    services: saved.services.length ? saved.services : draft.services, faqs: saved.faqs.length ? saved.faqs : draft.faqs,
  };
  const url = `${getEnv().APP_URL}${sitePath(org.slug)}`;
  const address = outreachSettings(org.settings).address;

  return (
    <>
      <PageHeader title="Website" subtitle="Your own public site, hosted here: your name, your colour, your words, and your enquiry form."
        actions={saved.published ? <a className="btn-secondary" href={sitePath(org.slug)} target="_blank" rel="noopener">View your site</a> : undefined} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
        <ActionForm action={saveSiteAction} className="space-y-6">
          {starter && <Notice title="Starter text loaded">This is a starting draft in the fields that were empty. Rewrite it in your own words, then save. Nothing has been saved yet.</Notice>}

          <Section title="Top of the page" actions={!starter && <Link href="/app/website?starter=1" className="btn-secondary btn-sm">Load starter text</Link>}>
            <div className="space-y-4">
              <Field label="Headline" name="headline" maxLength={L.headline} defaultValue={c.headline} hint="The title of your site and of its link preview." />
              <TextArea label="Introduction" name="intro" rows={3} maxLength={L.intro} defaultValue={c.intro} hint="Two or three sentences about what you do. Also used as the description in search results." />
            </div>
          </Section>

          <Section title="What we do" hint={`Up to ${L.items} services: a title and one sentence each. Leave a row empty to hide it.`}>
            <div className="space-y-4">
              {ROWS.map((i) => (
                <div key={i} className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
                  <Field label={`Service ${i + 1}`} name={`svcTitle${i + 1}`} maxLength={L.serviceTitle} defaultValue={c.services[i]?.title} />
                  <Field label={`Service ${i + 1} description`} name={`svcText${i + 1}`} maxLength={L.serviceText} defaultValue={c.services[i]?.text} />
                </div>
              ))}
            </div>
          </Section>

          <Section title="About" hint="“How it works” is added for you: the four real steps of your workflow, in fixed wording.">
            <TextArea label="About your business" name="about" rows={6} maxLength={L.about} defaultValue={c.about} />
          </Section>

          <Section title="Contact" hint="Only what you fill in is shown.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Phone" name="phone" type="tel" maxLength={L.phone} defaultValue={c.phone} />
              <Field label="Email" name="email" type="email" maxLength={L.email} defaultValue={c.email} />
              <Field label="Hours" name="hours" maxLength={L.hours} defaultValue={c.hours} placeholder="Mon–Fri, 9am–5pm" />
              <Field label="Service area" name="area" maxLength={L.area} defaultValue={c.area} placeholder="Austin, Texas" />
            </div>
          </Section>

          <Section title="Questions and answers" hint={`Up to ${L.items}. Leave a row empty to hide it.`}>
            <div className="space-y-5">
              {ROWS.map((i) => (
                <div key={i} className="space-y-3">
                  <Field label={`Question ${i + 1}`} name={`faqQ${i + 1}`} maxLength={L.question} defaultValue={c.faqs[i]?.q} />
                  <TextArea label={`Answer ${i + 1}`} name={`faqA${i + 1}`} rows={2} maxLength={L.answer} defaultValue={c.faqs[i]?.a} />
                </div>
              ))}
            </div>
          </Section>

          <SubmitButton pendingText="Saving…">Save website</SubmitButton>
        </ActionForm>

        <aside className="space-y-6">
          <Section title="Your site" actions={<Badge tone={saved.published ? 'ok' : 'neutral'}>{saved.published ? 'Published' : 'Not published'}</Badge>}>
            <ShareLink url={url}>
              <CopyButton value={url} label="Copy link" />
              {saved.published && <a className="btn-ghost btn-sm" href={sitePath(org.slug)} target="_blank" rel="noopener">View your site</a>}
            </ShareLink>
            <ActionForm action={setSitePublishedAction} className="mt-4 border-t border-line pt-4">
              <input type="hidden" name="on" value={saved.published ? 'false' : 'true'} />
              <p className="mb-3 text-[0.8125rem] text-muted">{saved.published ? 'Anyone with the address can see your site, and search engines may list it.' : 'Until you publish, the address shows “page not found”. Save your text first.'}</p>
              <SubmitButton variant={saved.published ? 'secondary' : 'primary'}>{saved.published ? 'Unpublish' : 'Publish site'}</SubmitButton>
            </ActionForm>
          </Section>

          <DomainSection ctx={ctx} />

          <Section plain title="Good to know">
            <ul className="space-y-3 text-[0.8125rem] leading-relaxed text-muted">
              <li>Text is plain text. It is checked when you save: promises of results, removals, score increases and “free” offers are not accepted.</li>
              <li>There is no testimonials or star-rating section: endorsements in advertising carry FTC rules of their own.</li>
              <li>The footer always shows the required notices and your business name{address ? <> with this mailing address: <span className="text-ink">{address}</span>.</> : <>. Add your mailing address under <Link href="/app/leads#follow-up" className="link">Leads</Link> and it is shown there too.</>}</li>
            </ul>
          </Section>
        </aside>
      </div>
    </>
  );
}
