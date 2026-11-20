'use server';

import { revalidatePath } from 'next/cache';
import type { ActionState } from '@/components/forms';
import { run } from '@/lib/action';
import { audit } from '@/lib/audit';
import { requireStaff } from '@/lib/auth/context';
import { channelUsable } from '@/lib/client-updates/service';
import { anyChannelOn, UPDATE_CHANNELS, UPDATE_EVENTS, updateSettings, US_ZONES } from '@/lib/client-updates/templates';

/**
 * Which client updates go out, per event and channel. A channel that is not connected cannot be switched on: its
 * boxes are disabled on the page and anything posted for it is saved as off, so a switch never claims more than the
 * configuration can do.
 */
export async function saveClientUpdatesAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('settings:manage');
  return run(async () => {
    const usable = { sms: channelUsable('sms'), email: channelUsable('email') };
    const switches = Object.fromEntries(UPDATE_EVENTS.map((e) => [e, Object.fromEntries(UPDATE_CHANNELS.map((ch) => [ch, usable[ch] && fd.get(`${e}.${ch}`) === 'on']))]));
    // The workspace's own time zone, used for quiet hours. Anything that is not one of the offered zones is ignored.
    const tz = US_ZONES.find((z) => z.value === fd.get('timezone'))?.value ?? null;
    let on = 0;
    await ctx.tx(async (db) => {
      const org = await db.row<{ settings: Record<string, unknown> }>('select settings from public.organizations where id = $1 for update', [ctx.orgId]);
      const before = updateSettings(org?.settings);
      const next = updateSettings({ client_updates: { switches } });
      // Windows that ended before this event was switched on are never announced after the fact.
      const windowSince = !anyChannelOn(next, 'window_passed') ? null : anyChannelOn(before, 'window_passed') && before.windowSince ? before.windowSince : new Date().toISOString();
      on = UPDATE_EVENTS.reduce((n, e) => n + Number(next.switches[e].sms) + Number(next.switches[e].email), 0);
      await db.run("update public.organizations set settings = settings || jsonb_build_object('client_updates', $2::jsonb) || case when $3::text is null then '{}'::jsonb else jsonb_build_object('timezone', $3::text) end where id = $1",
        [ctx.orgId, JSON.stringify({ switches: next.switches, window_since: windowSince }), tz]);
      await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'org.client_updates', entityType: 'organization', entityId: ctx.orgId, ip: ctx.meta.ip, meta: { switches_on: on } });
    });
    revalidatePath('/app/settings');
    return { ok: on ? `Saved. ${on} update${on === 1 ? ' is' : 's are'} switched on.` : 'Saved. No client updates are switched on.' };
  });
}
