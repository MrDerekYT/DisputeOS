import type { ConnectionOptions } from 'node:tls';

export function pgConnectionConfig(url: string, env?: { DATABASE_CA_CERT?: string; VERCEL?: string }): { connectionString: string; ssl: false | ConnectionOptions };
export function pgPoolMax(env?: { DB_POOL_MAX?: string; VERCEL?: string }): number;
export function explainPgError(e: Error & { code?: string }): string;
