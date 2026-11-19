import { REQUIRED_CONSENTS } from '@/lib/compliance/disclosures';
import { withSystem } from './helpers';

/** Test fixture: record the three required consents (signed long enough ago to be outside the cancellation window). */
export async function recordConsentRows(orgId: string, clientId: string, signedAt = new Date(Date.now() - 10 * 86_400_000)) {
  await withSystem(async (db) => {
    for (const kind of REQUIRED_CONSENTS)
      await db.run('insert into public.client_consents (org_id, client_id, kind, version, signed_name, signed_at) values ($1,$2,$3,$4,$5,$6)', [orgId, clientId, kind, 'test', 'Jordan Rivera', signedAt]);
  });
}
