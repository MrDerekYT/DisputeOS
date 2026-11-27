import { withSystem } from './db';
import { getEnv } from './env';
import { delivers, emailDisabled, sendEmail, type SendResult } from './mailer';

/**
 * Tells a workspace's owners and admins that a client did something that needs them: uploaded a file, sent a message,
 * signed an authorization. Each alert is an in-app notification (always) and an email (when email is connected).
 *
 * It never breaks the caller: it runs on the system connection after the client's own change is saved, and any error
 * is logged only. The same alert (title + link) is not repeated within ALERT_QUIET_MINUTES, so a client uploading five
 * pages in a row produces one email, not five.
 */
export const ALERT_QUIET_MINUTES = 10;

export interface StaffAlert { orgId: string; title: string; body: string; href: string }

export async function alertStaff(a: StaffAlert): Promise<{ notified: number; emailed: number }> {
  try {
    return await withSystem(async (db) => {
      const recent = await db.row(
        `select 1 from public.notifications where org_id = $1 and title = $2 and href = $3 and created_at > now() - ($4::int * interval '1 minute') limit 1`,
        [a.orgId, a.title.slice(0, 200), a.href, ALERT_QUIET_MINUTES]);
      if (recent) return { notified: 0, emailed: 0 };
      const staff = await db.rows<{ user_id: string; email: string; org_name: string }>(
        `select m.user_id, u.email, o.name as org_name from public.memberships m
           join public.users u on u.id = m.user_id join public.organizations o on o.id = m.org_id
          where m.org_id = $1 and m.role in ('owner', 'admin')`, [a.orgId]);
      for (const s of staff) {
        await db.run('insert into public.notifications (org_id, user_id, title, body, href) values ($1, $2, $3, $4, $5)',
          [a.orgId, s.user_id, a.title.slice(0, 200), a.body.slice(0, 1000), a.href]);
      }
      let emailed = 0;
      if (!emailDisabled()) {
        const env = getEnv();
        const link = `${env.APP_URL.replace(/\/$/, '')}${a.href}`;
        for (const s of staff) {
          const r = await sendEmail({
            to: s.email,
            subject: a.title.slice(0, 150),
            text: `${a.body}\n\nOpen it: ${link}\n\n— ${s.org_name}\nYou get this because you are an owner or admin of ${s.org_name}.`,
            fromName: s.org_name,
          }).catch((e): SendResult => ({ ok: false, provider: 'disabled', error: (e as Error).message }));
          if (delivers(r)) emailed++;
        }
      }
      return { notified: staff.length, emailed };
    });
  } catch (e) {
    console.error('[staff-alerts] could not alert', a.orgId, a.title, (e as Error).message);
    return { notified: 0, emailed: 0 };
  }
}

