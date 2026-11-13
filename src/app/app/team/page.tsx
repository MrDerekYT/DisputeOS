import type { Metadata } from 'next';
import { ActionForm, ConfirmButton, Field, Select, SubmitButton } from '@/components/forms';
import { Avatar, Badge, Notice, PageHeader, Section } from '@/components/ui';
import { requireStaff } from '@/lib/auth/context';
import { getAnalytics } from '@/lib/analytics';
import { grantableRoles } from '@/lib/rbac';
import { fmtDate, relTime, titleCase } from '@/lib/util';
import { changeRoleAction, inviteStaffAction, reassignClientsAction, removeMemberAction, resetMfaAction } from './actions';

export const metadata: Metadata = { title: 'Team' };

export default async function TeamPage() {
  const ctx = await requireStaff();
  if (!ctx.can('team:manage') && !ctx.can('analytics:team')) return <Notice tone="warn" title="Not available">Team management is for managers and admins.</Notice>;
  const manage = ctx.can('team:manage');
  const data = await ctx.tx(async (db) => ({
    members: await db.rows<{ id: string; name: string; email: string; role: string; totp: boolean; last_login_at: string | null; created_at: string }>(
      `select u.id, coalesce(nullif(u.full_name,''), u.email) as name, u.email, m.role, u.totp_enabled as totp, u.last_login_at, m.created_at from public.memberships m join public.users u on u.id = m.user_id where m.role <> 'client' order by (m.role = 'owner') desc, m.created_at`),
    invites: manage ? await db.rows<{ id: string; email: string; role: string; expires_at: string }>("select id, email, role, expires_at from public.invites where role <> 'client' and accepted_at is null and expires_at > now() order by created_at desc") : [],
    a: await getAnalytics(db, { rangeDays: 90, withTeam: true, withRevenue: false }),
  }));
  const byId = new Map(data.a.team.map((t) => [t.id, t]));
  const grant = grantableRoles(ctx.role);
  return (
    <>
      <PageHeader title="Team" subtitle="Who can do what in your workspace." />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          <div className="table-wrap"><table className="table"><thead><tr><th>Member</th><th>Role</th><th>2-step</th><th className="text-right">Active clients</th><th className="text-right">Open tasks</th><th>Last sign-in</th>{manage && <th></th>}</tr></thead>
            <tbody>{data.members.map((m) => {
              const t = byId.get(m.id);
              const editable = manage && m.role !== 'owner' && m.id !== ctx.userId && (m.role !== 'admin' || ctx.role === 'owner');
              return (
                <tr key={m.id}>
                  <td><div className="flex items-center gap-3"><Avatar name={m.name} size={32} /><div className="min-w-0"><div className="font-medium">{m.name}{m.id === ctx.userId && <span className="ml-1.5 text-xs text-muted">(you)</span>}</div><div className="truncate text-xs text-muted">{m.email}</div></div></div></td>
                  <td>{editable ? (
                    <form action={changeRoleAction} className="flex items-center gap-1.5"><input type="hidden" name="userId" value={m.id} />
                      <select name="role" defaultValue={m.role} className="field !w-auto !py-1 text-xs" aria-label={`Role for ${m.name}`}>{[m.role, ...grant].filter((r, i, a) => a.indexOf(r) === i && r !== 'owner').map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}</select>
                      <button className="btn-ghost btn-sm">Set</button></form>) : <Badge tone={m.role === 'owner' ? 'brand' : 'neutral'}>{titleCase(m.role)}</Badge>}</td>
                  <td>{m.totp ? <Badge tone="ok">On</Badge> : <Badge tone="warn">Not set up</Badge>}</td>
                  <td className="text-right tabular-nums">{t?.activeClients ?? 0}</td><td className="text-right tabular-nums">{t?.tasksOpen ?? 0}</td>
                  <td className="whitespace-nowrap text-muted">{m.last_login_at ? relTime(m.last_login_at) : 'Never'}</td>
                  {manage && <td className="whitespace-nowrap text-right">{editable && (<div className="flex justify-end gap-1.5">
                    {m.totp && <form action={resetMfaAction}><input type="hidden" name="userId" value={m.id} /><ConfirmButton className="btn-ghost btn-sm" message={`Reset two-step verification for ${m.name}? They will set it up again at next sign-in.`}>Reset 2-step</ConfirmButton></form>}
                    <form action={removeMemberAction}><input type="hidden" name="userId" value={m.id} /><ConfirmButton className="btn-ghost btn-sm text-bad" message={`Remove ${m.name} from the workspace? Their clients become unassigned.`}>Remove</ConfirmButton></form></div>)}</td>}
                </tr>);
            })}</tbody></table></div>

          {data.invites.length > 0 && (
            <Section title="Pending invitations"><ul className="divide-y divide-line text-sm">{data.invites.map((i) => <li key={i.id} className="flex items-center justify-between py-2.5"><span>{i.email} <Badge>{titleCase(i.role)}</Badge></span><span className="text-xs text-muted">expires {fmtDate(i.expires_at)}</span></li>)}</ul></Section>
          )}

          <Section title="Role permissions" hint="What each role can do. Clients have no staff access at all.">
            <div className="table-wrap !shadow-none"><table className="table"><thead><tr><th>Capability</th><th>Specialist</th><th>Manager</th><th>Admin / Owner</th></tr></thead><tbody>
              {[['Manage clients, reports, documents', 1, 1, 1], ['Draft disputes & letters', 1, 1, 1], ['Approve disputes & letters', 0, 1, 1], ['Assign clients to teammates', 0, 1, 1], ['See billing & revenue', 0, 1, 1], ['Team performance', 0, 1, 1], ['Configure automations', 0, 0, 1], ['Invite & manage staff, delete clients, settings, audit log', 0, 0, 1]].map(([c, a, b, d]) => (
                <tr key={c as string}><td>{c}</td>{[a, b, d].map((v, i) => <td key={i}>{v ? <span className="text-ok">✓</span> : <span className="text-faint">—</span>}</td>)}</tr>))}</tbody></table></div>
          </Section>
        </div>

        <div className="space-y-6">
          {manage && (
            <Section title="Invite a teammate">
              <ActionForm action={inviteStaffAction} resetOnSuccess className="space-y-3">
                <Field label="Work email" name="email" type="email" required />
                <Select label="Role" name="role" defaultValue="specialist" options={grant.map((r) => ({ value: r, label: titleCase(r) }))} />
                <SubmitButton>Send invitation</SubmitButton>
                <p className="text-xs text-muted">New staff must set up two-step verification before they can open any client data.</p>
              </ActionForm>
            </Section>
          )}
          {ctx.can('clients:assign') && data.members.length > 1 && (
            <Section title="Reassign clients" hint="Move every open client from one teammate to another — for example when someone leaves.">
              <ActionForm action={reassignClientsAction} className="space-y-3">
                <Select label="From" name="from" required options={data.members.map((m) => ({ value: m.id, label: m.name }))} placeholder="Choose…" />
                <Select label="To" name="to" placeholder="Unassigned" options={data.members.map((m) => ({ value: m.id, label: m.name }))} />
                <SubmitButton variant="secondary">Reassign</SubmitButton>
              </ActionForm>
            </Section>
          )}
        </div>
      </div>
    </>
  );
}
