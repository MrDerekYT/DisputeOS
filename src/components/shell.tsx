import Link from 'next/link';
import type { ReactNode } from 'react';
import { LogOut } from 'lucide-react';
import { logoutAction } from '@/app/auth-actions';
import { Avatar, Logo } from './ui';
import { CommandPalette } from './command-palette';
import { MobileDrawer, NavLinks, ThemeToggle, type NavItem } from './shell-client';
import type { Ctx } from '@/lib/auth/context';
import { titleCase } from '@/lib/util';

/** Main workflow first; tools and business admin are grouped below so the daily path is easy to scan. */
export function staffNav(ctx: Ctx, counts: { tasks?: number; inbox?: number } = {}): NavItem[] {
  const work = 'Daily work';
  const tools = 'Tools';
  const admin = 'Business';
  const items: NavItem[] = [
    { href: '/app', label: 'Dashboard', icon: 'home', group: work },
    { href: '/app/clients', label: 'Clients', icon: 'users', group: work },
    { href: '/app/disputes', label: 'Disputes', icon: 'gavel', group: work },
    { href: '/app/letters', label: 'Letters', icon: 'file', group: work },
    { href: '/app/tasks', label: 'Tasks', icon: 'tasks', badge: counts.tasks, group: work },
    { href: '/app/inbox', label: 'Inbox', icon: 'inbox', badge: counts.inbox, group: work },
    { href: '/app/assistant', label: 'AI assistant', icon: 'spark', group: tools },
  ];
  if (ctx.can('automations:manage')) items.push({ href: '/app/automations', label: 'Automations', icon: 'zap', group: tools });
  if (ctx.can('analytics:read')) items.push({ href: '/app/analytics', label: 'Analytics', icon: 'chart', group: tools });
  if (ctx.can('billing:read')) items.push({ href: '/app/billing', label: 'Billing', icon: 'card', group: admin });
  if (ctx.can('team:manage') || ctx.can('analytics:team')) items.push({ href: '/app/team', label: 'Team', icon: 'team', group: admin });
  if (ctx.can('settings:manage')) items.push({ href: '/app/settings', label: 'Settings', icon: 'settings', group: admin });
  if (ctx.can('audit:read')) items.push({ href: '/app/audit', label: 'Audit log', icon: 'audit', group: admin });
  return items;
}

function UserBlock({ name, email, role, org }: { name: string; email: string; role: string; org: string }) {
  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex items-center gap-3">
        <Avatar name={name || email} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{name || email}</div>
          <div className="truncate text-xs text-muted">{titleCase(role)} · {org}</div>
        </div>
      </div>
      <form action={logoutAction} className="mt-3">
        <button type="submit" className="btn-secondary btn-sm w-full"><LogOut size={14} aria-hidden /> Sign out</button>
      </form>
    </div>
  );
}

export function AppShell({ ctx, nav, children, wide }: { ctx: Ctx; nav: NavItem[]; children: ReactNode; wide?: boolean }) {
  const s = ctx.session;
  const user = <UserBlock name={s.fullName} email={s.email} role={s.role} org={s.orgName} />;
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[17rem_1fr]">
      <aside className="no-print sticky top-0 hidden h-screen flex-col border-r border-line bg-surface p-4 lg:flex">
        <Link href="/app" className="mb-6 px-2 pt-1"><Logo /></Link>
        <div className="flex-1 overflow-y-auto"><NavLinks items={nav} /></div>
        {user}
      </aside>
      <div className="min-w-0">
        <header className="no-print sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-canvas/85 px-4 py-2.5 backdrop-blur sm:px-6">
          <MobileDrawer items={nav}>{user}</MobileDrawer>
          <Link href="/app" className="lg:hidden"><Logo size={24} text={false} /></Link>
          <CommandPalette />
          <div className="ml-auto flex items-center gap-1">
            <Link href="/app/clients/new" className="btn-primary btn-sm">New client</Link>
            <ThemeToggle />
          </div>
        </header>
        <main id="main" className={`mx-auto w-full px-4 py-6 sm:px-6 sm:py-8 ${wide ? 'max-w-[90rem]' : 'max-w-7xl'}`}>{children}</main>
      </div>
    </div>
  );
}
