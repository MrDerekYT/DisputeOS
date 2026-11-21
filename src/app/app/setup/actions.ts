'use server';

import { revalidatePath } from 'next/cache';
import type { ActionState } from '@/components/forms';
import { run } from '@/lib/action';
import { requireStaff, type Ctx } from '@/lib/auth/context';
import { testAiConnection } from '@/lib/setup/test-ai';
import { sendTestEmail, sendTestSms, type TestActor, type TestSendResult } from '@/lib/setup/test-send';

const actor = (ctx: Ctx): TestActor => ({ userId: ctx.userId, orgId: ctx.orgId, role: ctx.role, email: ctx.session.email, orgName: ctx.session.orgName, tx: ctx.tx, ip: ctx.meta.ip });
const shown = (r: TestSendResult): ActionState => {
  revalidatePath('/app/setup');
  return r.ok ? { ok: r.message } : { error: r.message };
};

/** A test email to the signed-in person's own address. The rules are in src/lib/setup/test-send.ts. */
export async function sendTestEmailAction(_: ActionState, _fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('settings:manage');
  return run(async () => shown(await sendTestEmail(actor(ctx))));
}

/** One fixed, tiny request to the configured AI provider, with no client data. The rules are in src/lib/setup/test-ai.ts. */
export async function testAiConnectionAction(_: ActionState, _fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('settings:manage');
  return run(async () => shown(await testAiConnection(actor(ctx))));
}

/** A test text to a number the signed-in person types and confirms is their own. */
export async function sendTestSmsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireStaff('settings:manage');
  return run(async () => shown(await sendTestSms(actor(ctx), { phone: String(fd.get('phone') ?? '').slice(0, 40), confirmed: fd.get('own') === 'on' })));
}
