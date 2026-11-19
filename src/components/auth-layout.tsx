import Link from 'next/link';
import type { ReactNode } from 'react';
import { BellRing, FileCheck2, LockKeyhole, MessagesSquare, ShieldCheck, Smartphone } from 'lucide-react';
import { brandCss } from '@/lib/brand';
import type { OrgBrand } from '@/lib/org-brand';
import { tr, type Lang, type PortalKey } from '@/lib/portal-i18n';
import { PRODUCT } from '@/lib/product';
import { Logo, OrgMark } from './ui';

const STAFF_POINTS = [
  [ShieldCheck, 'Human approval before anything is sent. Always.'],
  [FileCheck2, 'Honest by design: no guarantees, no invented claims.'],
  [LockKeyhole, 'Documents encrypted at rest. Clients see only their own records.'],
] as const;

/** Client-facing points live in the portal copy table so they exist in English and Spanish. */
const CLIENT_POINTS: [typeof BellRing, PortalKey][] = [[BellRing, 'al_p1'], [Smartphone, 'al_p2'], [MessagesSquare, 'al_p3'], [LockKeyhole, 'al_p4']];

/**
 * A page with one message and no chrome: the "not found" page and a dead email link. With `logo` the product mark
 * links home; leave it off where the reader is someone's prospect and has never heard of the software.
 */
export function PlainPage({ eyebrow, title, children, logo = true }: { eyebrow?: string; title: string; children: ReactNode; logo?: boolean }) {
  return (
    <main id="main" className="mx-auto flex min-h-screen w-full max-w-xl flex-col px-5 py-8 sm:px-10">
      {logo && <Link href="/" className="w-fit rounded-lg"><Logo /></Link>}
      <div className="flex flex-1 flex-col justify-center py-12">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className="display mt-2 text-[2rem] sm:text-[2.5rem]">{title}</h1>
        <div className="mt-3 text-[0.9375rem] leading-relaxed text-muted">{children}</div>
      </div>
    </main>
  );
}

/**
 * Sign-in / sign-up frame. With `brand`, the page is the agency's own: their name, their colour, and the software's
 * name only as a small "Powered by" line — this is what their clients see. `lang` is the client's language on the
 * client-facing pages; staff pages leave it out.
 */
export function AuthLayout({ title, subtitle, children, footer, portal, brand, lang = 'en' }: {
  title: string; subtitle?: string; children: ReactNode; footer?: ReactNode; portal?: boolean; brand?: OrgBrand | null; lang?: Lang;
}) {
  const css = brand ? brandCss(brand.color) : null;
  const t = tr(lang);
  const points: (readonly [typeof BellRing, string])[] = portal ? CLIENT_POINTS.map(([Icon, k]) => [Icon, t(k)] as const) : [...STAFF_POINTS];
  return (
    <div className={brand ? 'brand-scope' : undefined} lang={lang}>
      {css && <style dangerouslySetInnerHTML={{ __html: css }} />}
      <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <main id="main" className="flex flex-col px-5 py-8 sm:px-10">
          {brand ? <div className="w-fit max-w-full"><OrgMark name={brand.name} /></div> : <Link href="/" className="w-fit"><Logo /></Link>}
          <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-10">
            <h1 className="display text-[2rem]">{title}</h1>
            {subtitle && <p className="mt-2 text-[0.9375rem] text-muted">{subtitle}</p>}
            <div className="mt-7">{children}</div>
            {footer && <div className="mt-6 text-sm text-muted">{footer}</div>}
          </div>
          <p className="mx-auto max-w-md text-center text-xs text-muted">
            {brand ? (PRODUCT.showPoweredBy ? `${t('poweredBy')} ${PRODUCT.name}` : t('al_secure')) : 'Protected by encrypted storage, tenant isolation and audit logging.'}
          </p>
        </main>
        {/* A "night" panel: dark in both themes, like the staff navigation rail. The agency's colour (when branded) marks the points. */}
        <aside className="night relative hidden border-l border-rail-line bg-rail p-12 lg:flex lg:flex-col lg:justify-center xl:p-16" aria-hidden>
          <div className="max-w-md">
            <span className="mb-8 block h-1 w-12 rounded-full bg-brand" />
            <p className="display text-[2rem] leading-[1.2]">
              {portal ? t('al_tagline') : 'Every dispute documented. Every letter reviewed by a person. Every action on the record.'}
            </p>
            <ul className="mt-10 space-y-5 text-[0.9375rem] text-muted">
              {points.map(([Icon, text]) => <li key={text} className="flex gap-3.5"><Icon size={20} strokeWidth={1.8} className="mt-0.5 shrink-0 text-brand" /> {text}</li>)}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
