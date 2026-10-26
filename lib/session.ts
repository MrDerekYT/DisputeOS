import type { SupabaseClient } from '@supabase/supabase-js';

export interface Profile {
  id: string;
  org_id: string;
  role: 'owner' | 'staff' | 'client';
}

/** Current user's profile; null if unauthenticated or not an org member (clients cannot use staff actions). */
export async function getStaffProfile(supabase: SupabaseClient): Promise<Profile | null> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return null;
  const { data } = await supabase
    .from('users')
    .select('id, org_id, role')
    .eq('id', auth.user.id)
    .single();
  if (!data || data.role === 'client') return null;
  return data as Profile;
}

/** Append-only audit entry. Metadata must never contain PII or report contents. */
export async function audit(
  supabase: SupabaseClient,
  p: Profile,
  action: string,
  entityType: string,
  entityId?: string,
  metadata: Record<string, string | number | boolean> = {},
) {
  await supabase
    .from('audit_logs')
    .insert({
      org_id: p.org_id,
      actor_id: p.id,
      action,
      entity_type: entityType,
      entity_id: entityId,
      metadata,
    });
}
