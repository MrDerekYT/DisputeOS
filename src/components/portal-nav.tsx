'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FileText, FolderUp, Home, ListChecks, MessageCircle, UserRound } from 'lucide-react';
import { cn } from '@/lib/util';

const ICONS = { home: Home, items: ListChecks, documents: FolderUp, letters: FileText, messages: MessageCircle, profile: UserRound };
export type PortalIcon = keyof typeof ICONS;
export interface PortalNavItem { href: string; label: string; short: string; icon: PortalIcon }

const isActive = (path: string, href: string) => (href === '/portal' ? path === href : path.startsWith(href));

/** Desktop/tablet: tabs under the header. */
export function PortalNav({ items }: { items: PortalNavItem[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Portal" className="mx-auto hidden max-w-5xl gap-1 px-3 sm:flex sm:px-5">
      {items.map(({ href, label }) => {
        const active = isActive(path, href);
        return <Link key={href} href={href} aria-current={active ? 'page' : undefined} className={cn('-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors', active ? 'border-brand text-ink' : 'border-transparent text-muted hover:text-ink')}>{label}</Link>;
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
    <nav aria-label="Portal" className="no-print fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur sm:hidden">
      <ul className="grid grid-cols-6">
        {items.map(({ href, label, short, icon }) => {
          const active = isActive(path, href);
          const Icon = ICONS[icon];
          return (
            <li key={href}>
              <Link href={href} aria-current={active ? 'page' : undefined} aria-label={label}
                className={cn('flex min-h-[3.5rem] flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium leading-tight transition-colors', active ? 'text-brand-strong' : 'text-muted')}>
                <span className={cn('grid h-7 w-12 place-items-center rounded-full transition-colors', active && 'bg-brand-soft')}><Icon size={19} strokeWidth={active ? 2.4 : 2} aria-hidden /></span>
                <span className="max-w-full truncate">{short}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
