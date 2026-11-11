import Link from 'next/link';
import type { ReactNode } from 'react';
import { LogOut } from 'lucide-react';
import { portalLogoutAction } from '@/app/portal/actions';
import { PRODUCT } from '@/lib/product';
import type { Lang } from '@/lib/portal-i18n';
import { tr } from '@/lib/portal-i18n';
import { OrgMark } from './ui';
import { PortalBottomNav, PortalNav, type PortalNavItem } from './portal-nav';

/**
 * The client's portal frame. It carries the agency's identity — their name, monogram and colour — because this is the
 * agency's relationship with its client. The software's name appears only as a small "Powered by" line.
 */
export function PortalShell({ lang, orgName, name, children }: { lang: Lang; orgName: string; name: string; children: ReactNode }) {
  const t = tr(lang);
  const items: PortalNavItem[] = [
    { href: '/portal', label: t('home'), short: t('n_home'), icon: 'home' },
    { href: '/portal/disputes', label: t('disputes'), short: t('n_items'), icon: 'items' },
    { href: '/portal/documents', label: t('documents'), short: t('n_documents'), icon: 'documents' },
    { href: '/portal/letters', label: t('letters'), short: t('n_letters'), icon: 'letters' },
    { href: '/portal/messages', label: t('messages'), short: t('n_messages'), icon: 'messages' },
    { href: '/portal/profile', label: t('profile'), short: t('n_profile'), icon: 'profile' },
  ];
  return (
    <div className="min-h-screen">
      <header className="no-print sticky top-0 z-30 border-b border-line bg-canvas/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link href="/portal" className="min-w-0" aria-label={`${orgName} — ${t('home')}`}><OrgMark name={orgName} /></Link>
          <div className="flex shrink-0 items-center gap-3"><span className="hidden text-sm text-muted md:block">{name}</span>
            <form action={portalLogoutAction}><button className="btn-secondary btn-sm" aria-label={t('signOut')}><LogOut size={14} aria-hidden className="sm:hidden" /><span className="hidden sm:inline">{t('signOut')}</span></button></form></div>
        </div>
        <PortalNav items={items} />
      </header>
      <main id="main" className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      <footer className="mx-auto max-w-5xl px-4 pb-28 text-xs leading-relaxed text-muted sm:px-6 sm:pb-10">
        <p>{t('disclaimer')}</p>
        {PRODUCT.showPoweredBy && <p className="mt-3 text-faint">{t('poweredBy')} {PRODUCT.name}</p>}
      </footer>
      <PortalBottomNav items={items} />
    </div>
  );
}
