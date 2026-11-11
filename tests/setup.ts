import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Unit tests need no database. DB tests (tests/db) use DATABASE_URL_TEST, defaulting to the local socket.
process.env.DATABASE_URL_TEST ??= `postgres://${os.userInfo().username}@/disputeos_test?host=${process.env.PGHOST ?? '/var/run/postgresql'}`;
process.env.STORAGE_DIR = mkdtempSync(path.join(os.tmpdir(), 'dos-test-storage-'));
process.env.EMAIL_DRIVER = 'log';
