// Test stand-in for the network, preloaded with `node --import` in front of scripts/verify-domain.mjs by
// tests/db/agency-domains.test.ts. The test runs the real script; this replaces the two network calls the script
// makes, the HTTPS request to the domain and the TXT lookup, with the answers given in DOMAIN_VERIFY_NET:
//   { "check": { "status": 200, "body": { "id": "<row id>" } },   left out: the domain cannot be reached
//     "txt": { "<record name>": ["<value>"] },                      left out: no such record
//     "txtError": "ETIMEOUT",                                       the lookup itself fails
//     "removedMeanwhile": true }                                    the domain's row is deleted while the script is checking
import dns from 'node:dns';
import pg from 'pg';
import { pgConnectionConfig } from '../../scripts/pg-config.mjs';

const net = JSON.parse(process.env.DOMAIN_VERIFY_NET ?? '{}');
const domain = process.argv.at(-1);

globalThis.fetch = async (url) => {
  if (String(url) !== `https://${domain}/api/domain-check`) throw new TypeError(`unexpected request: ${url}`);
  if (net.removedMeanwhile) {
    const db = new pg.Client(pgConnectionConfig(process.env.DATABASE_URL_TEST));
    await db.connect();
    await db.query('delete from public.agency_domains where domain = $1', [domain]);
    await db.end();
  }
  if (!net.check) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  return new Response(JSON.stringify(net.check.body ?? {}), { status: net.check.status ?? 200 });
};

dns.promises.Resolver.prototype.resolveTxt = async function resolveTxt(name) {
  if (net.txtError) throw Object.assign(new Error(`queryTxt ${net.txtError} ${name}`), { code: net.txtError });
  const values = net.txt?.[name];
  if (!values) throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
  return values.map((v) => [v]);
};
