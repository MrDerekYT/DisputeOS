#!/usr/bin/env node
// Prints fresh random values for the secrets a deployment generates itself, in .env format, to standard output.
//   npm run secrets:gen            (or: node scripts/gen-secrets.mjs)
// It writes no file and keeps no copy: paste the values into your host's environment settings (for Vercel, see
// docs/DEPLOY-VERCEL.md) and into your password manager. Every run prints different values.
//
// PII_ENCRYPTION_KEY encrypts client identifiers and every stored document. If it is lost, that data cannot be
// recovered; if it is replaced, existing data stops decrypting (see "Rotating the encryption key" in
// docs/ENVIRONMENTS.md). Generate it once per environment and back it up somewhere other than the host.
import { randomBytes } from 'node:crypto';

console.log(`# Generated ${new Date().toISOString()} — store these in a password manager; they are not saved anywhere else.`);
console.log(`PII_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
console.log('PII_ENCRYPTION_KEY_ID=1');
console.log(`CRON_SECRET=${randomBytes(24).toString('hex')}`);
