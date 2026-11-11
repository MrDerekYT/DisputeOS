import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticateApiKey, createApiKey, revokeApiKey } from '@/lib/api/keys';
import { ingestInbound, requestReportPull, type CActor } from '@/lib/credit/pull';
import { ingestBody, toParsed } from '@/lib/credit/schema';
import { getProvider, listProviders, sandboxReports } from '@/lib/credit/providers';
import { decideReport } from '@/lib/reports/service';
import { parseReportText } from '@/lib/reports/parser';
import { getEnv, resetEnvCache } from '@/lib/env';
import { recordConsentRows } from './consents';
import { addClient, addMember, addPortalClient, asUser, closePool, makeOrg, testIp, uniq, withSystem, type TestOrg } from './helpers';

let org: TestOrg;
let manager: { id: string };
let specialist: { id: string };
let actorOf: (id: string, role: CActor['role']) => CActor;

beforeAll(async () => {
  org = await makeOrg('Connect');
  manager = await addMember(org.orgId, 'manager');
  specialist = await addMember(org.orgId, 'specialist');
  actorOf = (id, role) => ({ orgId: org.orgId, userId: id, role });
});
afterAll(closePool);

const owner = (): CActor => ({ orgId: org.orgId, userId: org.ownerId, role: 'owner' });
const tx = (uid: string) => <T>(fn: Parameters<typeof asUser<T>>[1]) => asUser(uid, fn);
const ADMIN_ACTOR = () => ({ orgId: org.orgId, userId: org.ownerId });

describe('API keys', () => {
  it('shows the key once, stores only a hash, and authenticates it', async () => {
    const k = await asUser(org.ownerId, (db) => createApiKey(db, ADMIN_ACTOR(), { name: 'Zapier', scopes: ['clients:read', 'reports:write'] }));
    expect(k.key).toMatch(/^dosk_[a-z0-9]{8}_/);
    const stored = await withSystem((db) => db.rows<Record<string, unknown>>('select * from public.api_keys where id = $1', [k.id]));
    expect(JSON.stringify(stored)).not.toContain(k.key.split('_')[2]); // the secret is nowhere in the database
    const auth = await authenticateApiKey(`Bearer ${k.key}`, testIp());
    expect(auth).toMatchObject({ ok: true, principal: { orgId: org.orgId, userId: org.ownerId, role: 'owner', scopes: ['clients:read', 'reports:write'] } });
  });

  it('rejects missing, malformed, wrong and revoked keys', async () => {
    const k = await asUser(org.ownerId, (db) => createApiKey(db, ADMIN_ACTOR(), { name: 'Temp', scopes: ['clients:read'] }));
    for (const h of [null, 'Bearer', 'Basic abc', 'Bearer nope', `Bearer ${k.key.slice(0, -4)}AAAA`, `Bearer dosk_${k.prefix}_${'x'.repeat(43)}`])
      expect((await authenticateApiKey(h, testIp())).ok, String(h)).toBe(false);
    expect((await authenticateApiKey(`Bearer ${k.key}`, testIp())).ok).toBe(true);
    await asUser(org.ownerId, (db) => revokeApiKey(db, ADMIN_ACTOR(), k.id));
    expect((await authenticateApiKey(`Bearer ${k.key}`, testIp())).ok).toBe(false);
  });

  it('stops working when its owner leaves the organization or the org is suspended', async () => {
    const o = await makeOrg('Leaver');
    const k = await asUser(o.ownerId, (db) => createApiKey(db, { orgId: o.orgId, userId: o.ownerId }, { name: 'k', scopes: ['clients:read'] }));
    expect((await authenticateApiKey(`Bearer ${k.key}`, testIp())).ok).toBe(true);
    await withSystem((db) => db.run("update public.organizations set status = 'suspended' where id = $1", [o.orgId]));
    expect((await authenticateApiKey(`Bearer ${k.key}`, testIp())).ok).toBe(false);
    await withSystem((db) => db.run("update public.organizations set status = 'active' where id = $1", [o.orgId]));
    await withSystem((db) => db.run('delete from public.memberships where org_id = $1 and user_id = $2', [o.orgId, o.ownerId]));
    expect((await authenticateApiKey(`Bearer ${k.key}`, testIp())).ok).toBe(false);
  });

  it('requires at least one permission and only knows real scopes', async () => {
    await expect(asUser(org.ownerId, (db) => createApiKey(db, ADMIN_ACTOR(), { name: 'x', scopes: [] }))).rejects.toThrow(/at least one permission/);
    await expect(asUser(org.ownerId, (db) => createApiKey(db, ADMIN_ACTOR(), { name: 'x', scopes: ['root' as never] }))).rejects.toThrow(/at least one permission/);
  });

  it('only admins can create or see keys (database-enforced)', async () => {
    await expect(asUser(manager.id, (db) => createApiKey(db, { orgId: org.orgId, userId: manager.id }, { name: 'sneaky', scopes: ['clients:read'] }))).rejects.toThrow(/row-level security/);
    expect(await asUser(specialist.id, (db) => db.rows('select id from public.api_keys'))).toHaveLength(0);
    const { userId } = await addPortalClient(org.orgId);
    expect(await asUser(userId, (db) => db.rows('select id from public.api_keys'))).toHaveLength(0);
  });

  it('rate limits a key', async () => {
    const k = await asUser(org.ownerId, (db) => createApiKey(db, ADMIN_ACTOR(), { name: 'burst', scopes: ['clients:read'] }));
    const ip = testIp();
    let limited = false;
    for (let i = 0; i < 125 && !limited; i++) limited = (await authenticateApiKey(`Bearer ${k.key}`, ip)).ok === false;
    expect(limited).toBe(true);
  }, 60_000);
});

describe('payload validation', () => {
  const good = { reports: [{ bureau: 'experian', report_date: '2026-03-01', tradelines: [{ creditor_name: 'ACME', account_number: '4111111111111234', balance_cents: 12000 }] }] };
  it('accepts a valid report and keeps only the last four of the account number', () => {
    const p = ingestBody.parse(good);
    expect(JSON.stringify(toParsed(p.reports[0]!))).not.toContain('411111111111');
    expect(toParsed(p.reports[0]!).tradelines[0]!.account_last4).toBe('1234');
  });
  it.each([
    ['unknown bureau', { reports: [{ bureau: 'innovis' }] }], ['bad date', { reports: [{ bureau: 'experian', report_date: '03/01/2026' }] }],
    ['fractional cents', { reports: [{ bureau: 'equifax', tradelines: [{ creditor_name: 'A', balance_cents: 1.5 }] }] }],
    ['two reports for one bureau', { reports: [{ bureau: 'equifax' }, { bureau: 'equifax' }] }], ['empty creditor', { reports: [{ bureau: 'equifax', tradelines: [{ creditor_name: '' }] }] }],
    ['no reports', { reports: [] }], ['score out of range', { reports: [{ bureau: 'equifax', scores: [{ model: 'x', score: 1200 }] }] }],
  ])('rejects %s', (_n, body) => expect(ingestBody.safeParse(body).success).toBe(false));
});

describe('automatic import is gated by the client’s written authorization', () => {
  let clientId: string;
  beforeAll(async () => { clientId = await addClient(org.orgId, 'Pulled Client'); });

  it('refuses to import — pulled or pushed — until the FCRA authorization is on file', async () => {
    await expect(requestReportPull(tx(specialist.id), actorOf(specialist.id, 'specialist'), { clientId, provider: 'sandbox' })).rejects.toThrow(/written authorization/);
    await expect(asUser(manager.id, (db) => ingestInbound(db, actorOf(manager.id, 'manager'), clientId, { reports: [{ bureau: 'experian' }] }))).rejects.toThrow(/written authorization/);
    expect(await withSystem((db) => db.row<{ n: number }>('select count(*)::int as n from public.credit_reports where client_id = $1', [clientId]))).toEqual({ n: 0 });
  });

  it('a revoked authorization blocks imports again', async () => {
    await recordConsentRows(org.orgId, clientId);
    await withSystem((db) => db.run("update public.client_consents set revoked_at = now() where client_id = $1 and kind = 'fcra_authorization'", [clientId]));
    await expect(requestReportPull(tx(specialist.id), actorOf(specialist.id, 'specialist'), { clientId, provider: 'sandbox' })).rejects.toThrow(/written authorization/);
    await withSystem((db) => db.run("update public.client_consents set revoked_at = null where client_id = $1", [clientId]));
  });

  it('pulls from the sandbox into the review queue with scores, and records the authorization relied on', async () => {
    const r = await requestReportPull(tx(specialist.id), actorOf(specialist.id, 'specialist'), { clientId, provider: 'sandbox' });
    expect(r.reportIds).toHaveLength(3);
    const reps = await withSystem((db) => db.rows<{ status: string; source: string; bureau: string }>('select status, source, bureau from public.credit_reports where id = any($1::uuid[])', [r.reportIds]));
    expect(reps.every((x) => x.status === 'pending_review' && x.source === 'provider')).toBe(true);
    expect(reps.map((x) => x.bureau).sort()).toEqual(['equifax', 'experian', 'transunion']);
    const pull = await withSystem((db) => db.row<{ status: string; mode: string; consent_id: string | null; report_ids: string[] }>('select status, mode, consent_id, report_ids from public.report_pulls where id = $1', [r.pullId]));
    expect(pull).toMatchObject({ status: 'imported', mode: 'pull' });
    expect(pull!.consent_id).toBeTruthy();
    expect(await withSystem((db) => db.row<{ n: number }>('select count(*)::int as n from public.credit_scores where client_id = $1', [clientId]))).toEqual({ n: 3 });
    expect(await withSystem((db) => db.row<{ n: number }>("select count(*)::int as n from public.tradelines where client_id = $1 and creditor_name !~ '^(SANDBOX|SAMPLE|EXAMPLE)'", [clientId]))).toEqual({ n: 0 }); // everything is visibly synthetic
  });

  it('imported data still needs a person’s approval, and then yields real findings', async () => {
    expect(await withSystem((db) => db.row<{ n: number }>('select count(*)::int as n from public.findings where client_id = $1', [clientId]))).toEqual({ n: 0 });
    const ids = await withSystem((db) => db.rows<{ id: string }>("select id from public.credit_reports where client_id = $1 and status = 'pending_review'", [clientId]));
    for (const r of ids) await asUser(manager.id, (db) => decideReport(db, actorOf(manager.id, 'manager'), r.id, 'approved'));
    const cats = (await withSystem((db) => db.rows<{ category: string }>('select category from public.findings where client_id = $1', [clientId]))).map((f) => f.category);
    expect(cats).toContain('balance_mismatch');
  });

  it('partner-gated and unknown providers cannot be used', async () => {
    for (const provider of ['array', 'idiq', 'bureau-direct', 'nope'])
      await expect(requestReportPull(tx(specialist.id), actorOf(specialist.id, 'specialist'), { clientId, provider })).rejects.toThrow(/not available/);
  });

  it('only staff with report permission can pull', async () => {
    await expect(requestReportPull(tx(specialist.id), { ...actorOf(specialist.id, 'specialist'), role: 'client' }, { clientId, provider: 'sandbox' })).rejects.toThrow(/Not permitted/);
  });

  it('limits repeated pulls for one client', async () => {
    const c = await addClient(org.orgId, 'Hammered');
    await recordConsentRows(org.orgId, c);
    let blocked = false;
    for (let i = 0; i < 7 && !blocked; i++) {
      try { await requestReportPull(tx(specialist.id), actorOf(specialist.id, 'specialist'), { clientId: c, provider: 'sandbox' }); } catch (e) { blocked = /several pulls/.test((e as Error).message); }
    }
    expect(blocked).toBe(true);
  });

  it('inbound push: validated, deduplicated by external_ref, reviewed like everything else', async () => {
    const c = await addClient(org.orgId, 'Pushed Client');
    await recordConsentRows(org.orgId, c);
    const body = { external_ref: `ext-${uniq()}`, reports: [{ bureau: 'equifax', report_date: '2026-02-01', scores: [{ model: 'FICO 8', score: 641 }], tradelines: [{ creditor_name: 'PUSHED BANK', account_number: '999988887777', balance_cents: 55500 }] }] };
    await expect(asUser(manager.id, (db) => ingestInbound(db, actorOf(manager.id, 'manager'), c, { reports: [{ bureau: 'nope' }] }))).rejects.toThrow(/Invalid report payload/);
    const r = await asUser(manager.id, (db) => ingestInbound(db, { ...actorOf(manager.id, 'manager'), label: 'api:ab12cd34' }, c, body));
    expect(r.reportIds).toHaveLength(1);
    const t = await withSystem((db) => db.row<{ account_last4: string; status: string }>('select t.account_last4, r.status from public.tradelines t join public.credit_reports r on r.id = t.report_id where t.client_id = $1', [c]));
    expect(t).toEqual({ account_last4: '7777', status: 'pending_review' });
    expect(JSON.stringify(await withSystem((db) => db.rows('select * from public.tradelines where client_id = $1', [c])))).not.toContain('99998888');
    await expect(asUser(manager.id, (db) => ingestInbound(db, actorOf(manager.id, 'manager'), c, body))).rejects.toThrow(/already imported/);
    const audit = await withSystem((db) => db.row<{ actor_label: string }>("select actor_label from public.audit_logs where action = 'report.ingested' and entity_id = $1", [c]));
    expect(audit!.actor_label).toBe('api:ab12cd34');
  });

  it('cannot import into another tenant’s client', async () => {
    const other = await makeOrg('Foreign');
    const foreign = await addClient(other.orgId, 'Foreign Client');
    await recordConsentRows(other.orgId, foreign);
    await expect(asUser(manager.id, (db) => ingestInbound(db, actorOf(manager.id, 'manager'), foreign, { reports: [{ bureau: 'experian' }] }))).rejects.toThrow(/Client not found/);
  });
});

describe('credit scores', () => {
  it('are read from reports exactly as stated, and nothing else', () => {
    const r = parseReportText('Experian Credit Report\nReport Date: 02/01/2026\nVantageScore 3.0: 612\nFICO Score 8: 640\nCredit Score: 12\n');
    expect(r.scores!.map((s) => [s.model, s.score])).toEqual([['VantageScore 3.0', 612], ['FICO Score 8', 640]]);
    expect(r.scores![0]).toMatchObject({ bureau: 'experian', scored_on: '2026-02-01' });
  });
  it('clients can see only their own', async () => {
    const a = await addPortalClient(org.orgId, 'Score A');
    const b = await addPortalClient(org.orgId, 'Score B');
    for (const [c, s] of [[a.clientId, 600], [b.clientId, 700]] as const) {
      const rep = await withSystem((db) => db.row<{ id: string }>("insert into public.credit_reports (org_id, client_id, bureau, status) values ($1,$2,'experian','approved') returning id", [org.orgId, c]));
      await withSystem((db) => db.run("insert into public.credit_scores (org_id, client_id, report_id, bureau, model, score, scored_on) values ($1,$2,$3,'experian','VantageScore 3.0',$4,current_date)", [org.orgId, c, rep!.id, s]));
    }
    expect((await asUser(a.userId, (db) => db.rows<{ score: number }>('select score from public.credit_scores'))).map((r) => r.score)).toEqual([600]);
  });
});

describe('provider registry', () => {
  it('sandbox data is deterministic, schema-valid and visibly synthetic', () => {
    const a = sandboxReports('11111111-1111-1111-1111-111111111111', new Date('2026-03-01'));
    expect(JSON.stringify(a)).toEqual(JSON.stringify(sandboxReports('11111111-1111-1111-1111-111111111111', new Date('2026-03-01'))));
    expect(ingestBody.safeParse({ reports: a }).success).toBe(true);
    expect(JSON.stringify(a)).toMatch(/SANDBOX SYNTHETIC DATA/);
  });
  it('lists partner-gated providers honestly and never offers an adapter that does not exist', () => {
    const l = listProviders();
    expect(l.find((p) => p.key === 'sandbox')!.status).toBe('available');
    for (const k of ['array', 'idiq', 'smartcredit', 'bureau-direct']) {
      expect(l.find((p) => p.key === k)).toMatchObject({ status: 'needs_partner_approval' });
      expect(getProvider(k)).toBeNull();
    }
  });
  it('the sandbox does not exist in staging/production', () => {
    const saved = { ...process.env };
    try {
      resetEnvCache();
      Object.assign(process.env, { APP_ENV: 'production', DATABASE_URL: 'postgres://x/y', APP_URL: 'https://app.example.com', PII_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64') });
      expect(getEnv().APP_ENV).toBe('production');
      expect(getProvider('sandbox')).toBeNull();
      expect(listProviders().find((p) => p.key === 'sandbox')!.status).toBe('sandbox_unavailable');
    } finally {
      process.env = saved;
      resetEnvCache();
    }
  });
});
