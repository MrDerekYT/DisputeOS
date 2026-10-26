import { responseDueDate, daysRemaining, nextRound, isOverdue } from '@/lib/disputes';
import { mergeTemplate, generateBureauLetter } from '@/lib/letters';
import { encryptPII, decryptPII } from '@/lib/crypto';

test('due dates', () => {
  const s = new Date('2026-01-01T00:00:00Z');
  expect(responseDueDate(s).toISOString()).toBe('2026-01-31T00:00:00.000Z');
  expect(responseDueDate(s, true).toISOString()).toBe('2026-02-15T00:00:00.000Z');
  expect(daysRemaining(responseDueDate(s), s)).toBe(30);
  expect(isOverdue(responseDueDate(s), new Date('2026-03-01'))).toBe(true);
});

test('rounds cap at 3', () => {
  expect(nextRound(1)).toBe(2);
  expect(nextRound(3)).toBeNull();
});

test('template merge', () => {
  expect(mergeTemplate('Hi {{a}} {{b}}', { a: 'x' })).toBe('Hi x {{b}}');
  const l = generateBureauLetter({
    clientName: 'J',
    clientAddress: 'A',
    bureau: 'equifax',
    creditor: 'C',
    reason: 'R',
    date: new Date(),
  });
  expect(l).toContain('Equifax');
  expect(l).not.toContain('{{');
});

test('PII roundtrip', () => {
  process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  const c = encryptPII('123-45-6789');
  expect(c).not.toContain('123');
  expect(decryptPII(c)).toBe('123-45-6789');
});

import { newDisputeSchema, credentialsSchema } from '@/lib/validation';

test('validation', () => {
  const id = '3f2b8c1e-5a4d-4e7b-9c1a-2d3e4f5a6b7c';
  expect(
    newDisputeSchema.safeParse({
      clientId: id,
      tradelineId: id,
      bureau: 'experian',
      reason: 'Not my account',
    }).success,
  ).toBe(true);
  expect(
    newDisputeSchema.safeParse({
      clientId: 'x',
      tradelineId: id,
      bureau: 'experian',
      reason: 'Not my account',
    }).success,
  ).toBe(false);
  expect(
    newDisputeSchema.safeParse({
      clientId: id,
      tradelineId: id,
      bureau: 'bad',
      reason: 'Not my account',
    }).success,
  ).toBe(false);
  expect(credentialsSchema.safeParse({ email: 'a@b.co', password: 'short' }).success).toBe(false);
});

test('PII tamper detection and bad key', () => {
  process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  const b = Buffer.from(encryptPII('secret'), 'base64');
  b[b.length - 1] ^= 1;
  expect(() => decryptPII(b.toString('base64'))).toThrow();
  process.env.PII_ENCRYPTION_KEY = 'short';
  expect(() => encryptPII('x')).toThrow();
});
