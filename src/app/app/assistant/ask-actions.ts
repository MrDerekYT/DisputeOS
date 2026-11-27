'use server';

import { revalidatePath } from 'next/cache';
import { askAssistant, type AssistantReply } from '@/lib/assistant/ask';
import { requireStaff } from '@/lib/auth/context';

/**
 * "Ask about your clients" on the AI assistant page. The question is answered from the caller's own workspace, read
 * under their row-level security; `clientId` is the client the page was opened for, if any, and an id they cannot see
 * simply reads nothing. `useAi` false gives the answer built from the records, which is free and always available.
 * Asking never sends, changes or deletes anything in a client's file.
 */
export async function askAboutClients(question: string, clientId: string | null, useAi: boolean): Promise<AssistantReply> {
  const ctx = await requireStaff('clients:read');
  try {
    const reply = await askAssistant(
      { userId: ctx.userId, orgId: ctx.orgId, personal: ctx.session.orgMode === 'personal', billing: ctx.can('billing:read'), ip: ctx.meta.ip ?? null, tx: ctx.tx },
      { question, clientId, useAi: useAi === true });
    // An AI attempt writes to the credit ledger (a charge, or a charge and its refund): the balance on this page is refreshed.
    if (reply.ok && useAi === true) revalidatePath('/app/assistant');
    return reply;
  } catch (e) {
    console.error('[assistant]', e);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}
