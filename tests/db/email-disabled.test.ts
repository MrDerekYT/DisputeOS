import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { requestPasswordReset } from '@/lib/auth/service';
import { resetEnvCache } from '@/lib/env';
import { sentLog } from '@/lib/mailer';
import { closePool, makeOrg, testIp, withSystem } from './helpers';

/** EMAIL_DRIVER=disabled: the explicit "no email provider" mode. Nothing may be sent, and nothing may pretend to be. */
describe('password reset with email disabled', () => {
  afterEach(() => { process.env.EMAIL_DRIVER = 'log'; resetEnvCache(); });
  afterAll(async () => { await closePool(); });

  it('creates no reset token and sends nothing, because there is no way to deliver the link', async () => {
    const org = await makeOrg('NoEmail');
    const resets = () => withSystem((db) => db.row<{ n: number }>('select count(*)::int as n from public.password_resets where user_id = $1', [org.ownerId]));
    process.env.EMAIL_DRIVER = 'disabled'; resetEnvCache();
    const before = sentLog.length;
    await requestPasswordReset(org.ownerEmail, { ip: testIp() });
    expect((await resets())!.n).toBe(0);
    expect(sentLog.length).toBe(before);
    // The same request with a working driver does create one: the check above is not passing by accident.
    process.env.EMAIL_DRIVER = 'log'; resetEnvCache();
    await requestPasswordReset(org.ownerEmail, { ip: testIp() });
    expect((await resets())!.n).toBe(1);
    expect(sentLog.length).toBe(before + 1);
  });
});
