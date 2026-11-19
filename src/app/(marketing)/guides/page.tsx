import type { Metadata } from 'next';
import { CtaBand, GuideLink, JsonLd, PageIntro, WRAP } from '@/components/marketing-site';
import { PRODUCT } from '@/lib/product';
import { GUIDES, breadcrumbLd, pageMeta } from '@/lib/site';
import { cn } from '@/lib/util';

export const generateMetadata = (): Metadata => pageMeta({
  title: `Guides for Credit Repair Businesses: CROA, FCRA Timelines, Reports | ${PRODUCT.name}`,
  description: 'Plain-language guides for people who run a credit repair business: how the dispute investigation clock works, what CROA requires before you take a client, and how to read a credit report.',
  path: '/guides',
});

export default function GuidesPage() {
  return (
    <>
      <PageIntro title="Guides for running a credit repair business by the book."
        lede="Short, specific and written for agency owners. Each one says what the law requires in plain language and where to check it. None of them is legal advice." />
      <section className={cn(WRAP, 'pt-12')} aria-label="All guides">
        <ul className="grid gap-x-12 gap-y-12 lg:grid-cols-3">
          {GUIDES.map((g) => <li key={g.slug} className="border-t border-line pt-6"><GuideLink slug={g.slug} /></li>)}
        </ul>
      </section>
      <CtaBand />
      <JsonLd data={breadcrumbLd([{ name: 'Home', path: '/' }, { name: 'Guides', path: '/guides' }])} />
    </>
  );
}
