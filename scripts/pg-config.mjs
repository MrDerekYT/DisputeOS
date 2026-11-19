// Connection settings shared by the app (src/lib/db.ts) and the command-line scripts, so they all reach the database
// the same way. Plain JavaScript on purpose: the scripts run under bare `node`, the app imports the same file.
//
// TLS: a database on another machine is always reached over TLS with the server certificate and hostname VERIFIED.
//   - Certificate signed by a public CA: nothing to configure.
//   - Certificate signed by a private CA (Supabase: Database Settings → SSL Configuration → download the CA certificate):
//     put the PEM text in DATABASE_CA_CERT. Real line breaks or the two characters `\n` both work.
//   - A database on this machine (localhost, a unix socket) is reached without TLS unless the URL asks for it.
//   - `?sslmode=disable` in the URL turns TLS off altogether. It is only for a database on a private network (docker
//     compose, a CI service container), never for a hosted one, and it is refused on Vercel.
// Certificate verification is never switched off: `sslmode=require`, `prefer` and `no-verify` all mean "verify" here.

const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]']);

const isLocalHost = (h) => h.startsWith('/') || /^%2f/i.test(h) || LOCAL_HOSTS.has(h);

/** @param {string} url @param {{ DATABASE_CA_CERT?: string, VERCEL?: string }} [env] */
export function pgConnectionConfig(url, env = process.env) {
  let u;
  let socketOnly = false; // postgres://user@/db?host=/var/run/postgresql has no host for URL() to parse
  try {
    try {
      u = new URL(url);
    } catch {
      u = new URL(url.replace('@/', '@socket.invalid/'));
      socketOnly = true;
    }
  } catch {
    throw new Error('DATABASE_URL is not a valid postgres:// URL. If the password contains characters such as @ : / ? # or %, percent-encode them.');
  }
  const ca = (env.DATABASE_CA_CERT ?? '').replace(/\\n/g, '\n').trim();
  if (ca && !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(ca)) {
    throw new Error('DATABASE_CA_CERT must be the PEM text of a CA certificate (it starts with -----BEGIN CERTIFICATE-----).');
  }
  const mode = u.searchParams.get('sslmode');
  if (mode === 'disable' && env.VERCEL) {
    throw new Error('DATABASE_URL must not contain sslmode=disable on Vercel: it would send the database password and all data unencrypted. Remove it.');
  }
  // Local means the host pg will really connect to is this machine. A `host=` parameter replaces the host in the URL
  // (a percent-encoded host such as %2Fvar%2Frun%2Fpostgresql is a socket directory), and with no host at all pg
  // falls back to PGHOST. Every candidate has to be local, otherwise TLS is used.
  const hostParams = u.searchParams.getAll('host');
  const hosts = hostParams.length ? hostParams : [socketOnly ? '' : u.hostname];
  if (hosts.includes('')) hosts.push(process.env.PGHOST ?? '');
  const local = hosts.every(isLocalHost);
  // pg lets ssl settings found in the URL replace the ones passed next to it, so they are taken out of the URL here.
  let connectionString = url;
  const sslParams = ['sslmode', 'ssl', 'sslrootcert', 'uselibpqcompat'].filter((k) => u.searchParams.has(k));
  if (sslParams.length) {
    for (const k of sslParams) u.searchParams.delete(k);
    connectionString = socketOnly ? u.toString().replace('@socket.invalid/', '@/') : u.toString();
  }
  if (mode === 'disable' || (local && !mode && !ca)) return { connectionString, ssl: false };
  return { connectionString, ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) } };
}

/**
 * How many connections one server process may hold. A serverless instance handles few requests at a time and there
 * can be many instances, so the default there is small; DB_POOL_MAX overrides it either way.
 * @param {{ DB_POOL_MAX?: string, VERCEL?: string }} [env]
 */
export function pgPoolMax(env = process.env) {
  const n = Number(env.DB_POOL_MAX);
  if (env.DB_POOL_MAX && Number.isInteger(n) && n >= 1 && n <= 50) return n;
  return env.VERCEL ? 3 : 10;
}

/** A connection failure explained in terms of what to change. @param {Error & { code?: string }} e */
export function explainPgError(e) {
  const code = e.code ?? '';
  if (['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT'].includes(code)) {
    return `${e.message} — the database's TLS certificate is not signed by a CA this machine trusts. Set DATABASE_CA_CERT to the PEM text of the database's CA certificate (Supabase: Database Settings → SSL Configuration → download certificate).`;
  }
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return `${e.message} — the certificate does not match the host in DATABASE_URL. Use the host name exactly as your provider shows it.`;
  if (/does not support SSL/i.test(e.message)) return `${e.message} — this server has no TLS. Use a server with TLS; only for a database on your own private network (never a hosted one such as Supabase), add ?sslmode=disable to DATABASE_URL.`;
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH' || code === 'ENOTFOUND') return `${e.message} — the host could not be reached. A Supabase direct host (db.<ref>.supabase.co) is IPv6-only; use the connection pooler string instead.`;
  return e.message;
}
