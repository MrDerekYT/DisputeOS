import Link from 'next/link';
import type { ReactNode } from 'react';
import { BellRing, FileCheck2, LockKeyhole, MessagesSquare, ShieldCheck, Smartphone } from 'lucide-react';
import { brandCss } from '@/lib/brand';
import type { OrgBrand } from '@/lib/org-brand';
import { PRODUCT } from '@/lib/product';
import { Logo, OrgMark } from './ui';

const STAFF_POINTS = [
  [ShieldCheck, 'Human approval before anything is sent. Always.'],
  [FileCheck2, 'Honest by design: no guarantees, no invented claims.'],
  [LockKeyhole, 'Documents encrypted at rest. Clients see only their own records.'],
] as const;

const CLIENT_POINTS = [
  [BellRing, 'Plain-language updates on every item — what was sent, when, and what came back.'],
  [Smartphone, 'Upload documents and sign agreements from your phone.'],
  [MessagesSquare, 'Message your specialist directly. Every answer stays in one place.'],
  [LockKeyhole, 'Your files are encrypted. Only you and your specialist’s team can see them.'],
] as const;

/**
 * Sign-in / sign-up frame. With `brand`, the page is the agency's own: their name, their colour, and the software's
 * name only as a small "Powered by" line — this is what their clients see.
 */
export function AuthLayout({ title, subtitle, children, footer, portal, brand }: {
  title: string; subtitle?: string; children: ReactNode; footer?: ReactNode; portal?: boolean; brand?: OrgBrand | null;
}) {
  const css = brand ? brandCss(brand.color) : null;
  const points = portal ? CLIENT_POINTS : STAFF_POINTS;
  return (
    <div className={brand ? 'brand-scope' : undefined}>
      {css && <style dangerouslySetInnerHTML={{ __html: css }} />}
      <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <main id="main" className="flex flex-col px-5 py-8 sm:px-10">
          {brand ? <div className="w-fit max-w-full"><OrgMark name={brand.name} /></div> : <Link href="/" className="w-fit"><Logo /></Link>}
          <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-10">
            <h1 className="font-display text-3xl font-semibold">{title}</h1>
            {subtitle && <p className="mt-2 text-sm text-muted">{subtitle}</p>}
            <div className="mt-7">{children}</div>
            {footer && <div className="mt-6 text-sm text-muted">{footer}</div>}
          </div>
          <p className="mx-auto max-w-md text-center text-xs text-faint">
            {brand ? <>Secure client portal{PRODUCT.showPoweredBy && <> · Powered by {PRODUCT.name}</>}</> : 'Protected by encrypted storage, tenant isolation and audit logging.'}
          </p>
        </main>
        <aside className="relative hidden overflow-hidden bg-[rgb(var(--brand-strong))] p-12 text-white lg:flex lg:flex-col lg:justify-center" aria-hidden>
          <svg className="absolute inset-0 h-full w-full opacity-[0.07]" viewBox="0 0 400 400" preserveAspectRatio="xMidYMid slice">
            <defs><pattern id="g" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="white" strokeWidth="1" /></pattern></defs>
            <rect width="400" height="400" fill="url(#g)" />
          </svg>
          <div className="relative max-w-md">
            <p className="font-display text-3xl font-semibold leading-snug">
              {portal ? 'See exactly where every item stands — no guessing, no chasing.' : 'Every dispute documented. Every letter reviewed by a person. Every action on the record.'}
            </p>
            <ul className="mt-10 space-y-5 text-[15px] text-white/85">
              {points.map(([Icon, text]) => <li key={text} className="flex gap-3"><Icon size={20} className="mt-0.5 shrink-0" /> {text}</li>)}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
