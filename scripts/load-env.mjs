// Loads .env.<APP_ENV>.local, .env.local and .env (first definition wins; real environment variables always win).
import { existsSync } from 'node:fs';

const appEnv = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';
for (const f of [`.env.${appEnv}.local`, '.env.local', '.env']) {
  if (existsSync(f)) process.loadEnvFile(f);
}
