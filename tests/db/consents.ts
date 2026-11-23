import { REQUIRED_CONSENTS } from '@/lib/compliance/disclosures';
import { withSystem } from './helpers';

/** 400 days: longer than the year back a sent date may be recorded (checkSentOn), so every test letter is sent after it. */
export const LONG_AGO_DAYS = 400;

/**
 * Test fixture: record the four required consents (signed long enough ago to be outside the cancellation window, and
 * before any sent date a test can record: a letter or dispute cannot be recorded as sent before the agreement was
 * signed or inside its cancellation period, src/lib/agreements.ts). Rows as signed before migration 0031: no stored
 * text, version 'test'.
 */
export async function recordConsentRows(orgId: string, clientId: string, signedAt = new Date(Date.now() - LONG_AGO_DAYS * 86_400_000)) {
  await withSystem(async (db) => {
    for (const kind of REQUIRED_CONSENTS)
      await db.run('insert into public.client_consents (org_id, client_id, kind, version, signed_name, signed_at) values ($1,$2,$3,$4,$5,$6)', [orgId, clientId, kind, 'test', 'Jordan Rivera', signedAt]);
  });
}
