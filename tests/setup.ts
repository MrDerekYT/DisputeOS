import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Unit tests need no database. DB tests (tests/db) use DATABASE_URL_TEST, defaulting to the local socket.
process.env.DATABASE_URL_TEST ??= `postgres://${os.userInfo().username}@/disputeos_test?host=${process.env.PGHOST ?? '/var/run/postgresql'}`;
process.env.STORAGE_DIR = mkdtempSync(path.join(os.tmpdir(), 'dos-test-storage-'));
process.env.EMAIL_DRIVER = 'log';
// The deployment-wide outreach limits count rows of every workspace in the database, and the test database keeps the
// rows of earlier runs (tests never truncate shared tables). So the limits are lifted here; the tests that are about
// them set their own, relative to what is already there.
process.env.OUTREACH_PLATFORM_DAILY_EMAILS ??= '10000000';
process.env.OUTREACH_PLATFORM_DAILY_TEXTS ??= '10000000';
