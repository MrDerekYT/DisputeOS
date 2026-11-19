import Link from 'next/link';
import type { ReactNode } from 'react';
import { LogOut, Plus, Sparkles } from 'lucide-react';
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
    { href: '/app/leads', label: 'Leads', icon: 'lead', group: work },
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
  // An agency's public website, hosted by this app (personal workspaces have none).
  if (ctx.can('settings:manage') && ctx.session.orgMode === 'agency') items.push({ href: '/app/website', label: 'Website', icon: 'globe', group: admin });
  // Every staff member has a Settings page (their own password and security); workspace settings on it stay admin-only.
  items.push({ href: '/app/settings', label: 'Settings', icon: 'settings', group: admin });
  if (ctx.can('audit:read')) items.push({ href: '/app/audit', label: 'Audit log', icon: 'audit', group: admin });
  return items;
}

/**
 * The workspace's AI credit balance, read from the ledger (src/lib/ai/credits.ts). It shows the balance only: there is
 * no allowance or renewal date to show, because plans do not exist yet.
 */
function CreditsMeter({ balance }: { balance: number }) {
  return (
    <div className="rounded-xl bg-rail-active/60 px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-semibold text-rail-ink"><Sparkles size={15} aria-hidden className="text-brand" /> AI credits</span>
        <span className="font-display text-lg font-semibold tabular-nums text-rail-ink" data-ai-credits={balance}>{balance.toLocaleString('en-US')}</span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-3 text-[0.8125rem]">
        <span className="text-rail-muted">{balance > 0 ? 'available' : 'none left'}</span>
        <Link href="/app/assistant#ai-credits" className="link">View credits</Link>
      </div>
    </div>
  );
}

function UserBlock({ name, email, role, org }: { name: string; email: string; role: string; org: string }) {
  return (
    <div className="mt-3 flex items-center gap-3 border-t border-rail-line pt-3">
      <Avatar name={name || email} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-rail-ink">{name || email}</div>
        <div className="truncate text-[0.8125rem] text-rail-muted">{titleCase(role)}, {org}</div>
      </div>
      <form action={logoutAction}>
        <button type="submit" aria-label="Sign out" title="Sign out" className="grid h-9 w-9 place-items-center rounded-lg text-rail-muted transition-colors hover:bg-rail-active hover:text-rail-ink"><LogOut size={17} aria-hidden /></button>
      </form>
    </div>
  );
}

/**
 * The staff frame: a navigation rail that is dark in both themes, and a top bar with search, the credit guide,
 * "New client" and the theme toggle. `credits` is the workspace's real AI credit balance; `guide` is the credit guide
 * (its button renders here in the top bar).
 */
export function AppShell({ ctx, nav, children, wide, credits, guide }: { ctx: Ctx; nav: NavItem[]; children: ReactNode; wide?: boolean; credits?: number; guide?: ReactNode }) {
  const s = ctx.session;
  const foot = (
    <div className="mt-3 shrink-0">
      {credits != null && <CreditsMeter balance={credits} />}
      <UserBlock name={s.fullName} email={s.email} role={s.role} org={s.orgName} />
    </div>
  );
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[16.5rem_minmax(0,1fr)]">
      <aside className="night no-print sticky top-0 hidden h-screen flex-col border-r border-rail-line bg-rail p-3.5 lg:flex">
        <Link href="/app" className="mb-5 w-fit rounded-lg px-2 pt-2"><Logo /></Link>
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1"><NavLinks items={nav} /></div>
        {foot}
      </aside>
      <div className="min-w-0">
        {/* No backdrop blur here: a filter would make this header the containing block for the guide's fixed panel. */}
        <header className="no-print sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-canvas px-4 py-2.5 sm:gap-3 sm:px-6 lg:px-8">
          <MobileDrawer items={nav}>{foot}</MobileDrawer>
          <Link href="/app" className="rounded-lg lg:hidden"><Logo size={26} text={false} /></Link>
          <CommandPalette />
          <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
            {guide}
            <Link href="/app/clients/new" className="btn-primary"><Plus size={16} aria-hidden className="hidden sm:block" /> New client</Link>
            <ThemeToggle />
          </div>
        </header>
        <main id="main" className={`mx-auto w-full px-4 py-6 sm:px-6 sm:py-8 lg:px-8 ${wide ? 'max-w-[90rem]' : 'max-w-7xl'}`}>{children}</main>
      </div>
    </div>
  );
}
