'use server';

import { revalidatePath } from 'next/cache';
import { audit } from '@/lib/audit';
import { requireStaff } from '@/lib/auth/context';
import { setAutoTailor } from '@/lib/letters/tailor-load';

/**
 * "Tailor wording automatically when a letter is drafted". Off until an owner or admin turns it on: it spends the
 * workspace's AI credits on every drafted letter, so the agency decides. It changes how a DRAFT is worded and nothing
 * else: a person still reads each letter and a manager still approves it. Read by autoTailorDraft.
 */
export async function setLetterAutoTailorAction(fd: FormData) {
  const ctx = await requireStaff('settings:manage');
  const on = fd.get('on') === 'true';
  await ctx.tx(async (db) => {
    await setAutoTailor(db, ctx.orgId, on);
    await audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: 'org.letter_auto_tailor', entityType: 'organization', entityId: ctx.orgId, ip: ctx.meta.ip, meta: { enabled: on } });
  });
  revalidatePath('/app/assistant');
}
