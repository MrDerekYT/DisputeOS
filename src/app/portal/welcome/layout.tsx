import type { ReactNode } from 'react';
import Link from 'next/link';
import { OrgMark } from '@/components/ui';
import { brandCss } from '@/lib/brand';
import { portalContext } from '@/lib/portal';
import { PRODUCT } from '@/lib/product';

/**
 * The welcome steps get a focused frame of their own: the agency's name and colour, a way out ("Finish later"), and
 * none of the portal's navigation, so a new client sees one thing at a time.
 */
export default async function WelcomeLayout({ children }: { children: ReactNode }) {
  const { ctx, lang, t } = await portalContext();
  const color = await ctx.tx((db) => db.row<{ c: string | null }>("select settings->>'brand_color' as c from public.organizations where id = $1", [ctx.orgId]));
  const css = brandCss(color?.c);
  return (
    <div className="brand-scope min-h-screen" lang={lang}>
      {css && <style dangerouslySetInnerHTML={{ __html: css }} />}
      <header className="no-print border-b border-line bg-canvas">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 flex-1"><OrgMark name={ctx.session.orgName} /></div>
          <Link href="/portal" className="btn-quiet btn-sm shrink-0">{t('wl_later')}</Link>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-3xl px-4 pb-16 pt-6 sm:px-6 sm:pt-8">{children}</main>
      {PRODUCT.showPoweredBy && <footer className="mx-auto max-w-3xl px-4 pb-10 text-xs text-faint sm:px-6">{t('poweredBy')} {PRODUCT.name}</footer>}
    </div>
  );
}
