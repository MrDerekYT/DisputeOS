'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FileText, FolderUp, Home, ListChecks, MessageCircle, UserRound } from 'lucide-react';
import { cn } from '@/lib/util';

const ICONS = { home: Home, items: ListChecks, documents: FolderUp, letters: FileText, messages: MessageCircle, profile: UserRound };
export type PortalIcon = keyof typeof ICONS;
export interface PortalNavItem { href: string; label: string; short: string; icon: PortalIcon }

const isActive = (path: string, href: string) => (href === '/portal' ? path === href : path.startsWith(href));

/**
 * The legal note under every portal page. In full where it matters most — Home (beside "Your rights"), My items (where
 * outcomes are shown) and Profile (where the agreements are signed). On the other pages one line says the essential
 * part and links to the full list of rights, so the disclosure is always one tap away without repeating on every screen.
 */
const FULL_NOTE = ['/portal', '/portal/disputes', '/portal/profile'];
export function PortalFooterNote({ full, short, rights }: { full: string; short: string; rights: string }) {
  const path = usePathname();
  if (FULL_NOTE.includes(path)) return <p className="max-w-2xl">{full}</p>;
  return <p className="max-w-2xl">{short} <Link href="/portal#rights" className="link">{rights}</Link></p>;
}

/** Desktop/tablet: tabs under the header. */
export function PortalNav({ items }: { items: PortalNavItem[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Portal" className="mx-auto hidden max-w-5xl gap-1 overflow-x-auto px-3 sm:flex sm:px-5">
      {items.map(({ href, label }) => {
        const active = isActive(path, href);
        return <Link key={href} href={href} aria-current={active ? 'page' : undefined} className={cn('-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm transition-colors', active ? 'border-brand font-semibold text-ink' : 'border-transparent font-medium text-muted hover:border-line-strong hover:text-ink')}>{label}</Link>;
      })}
    </nav>
  );
}

/**
 * Phones: an app-style bar fixed to the bottom, within thumb reach. Must be rendered outside the header — the header's
 * backdrop blur makes it the containing block for fixed-position children, which would pin this bar to the header.
 */
export function PortalBottomNav({ items }: { items: PortalNavItem[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Portal" className="no-print fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] sm:hidden">
      <ul className="grid grid-cols-6">
        {items.map(({ href, label, short, icon }) => {
          const active = isActive(path, href);
          const Icon = ICONS[icon];
          return (
            <li key={href}>
              <Link href={href} aria-current={active ? 'page' : undefined} aria-label={label}
                className={cn('flex min-h-[3.75rem] flex-col items-center justify-center gap-0.5 px-1 text-[0.6875rem] leading-tight transition-colors', active ? 'font-semibold text-brand-strong' : 'font-medium text-muted')}>
                <span className={cn('grid h-7 w-12 place-items-center rounded-full transition-colors', active && 'bg-brand-soft')}><Icon size={19} strokeWidth={active ? 2.2 : 1.8} aria-hidden /></span>
                <span className="max-w-full truncate">{short}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
