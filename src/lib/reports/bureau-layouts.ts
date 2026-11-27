import { maskSnippet, normalizeDate, parseMoneyToCents } from './parser';
import type { FieldMeta, ParsedIdentity, ParsedInquiry, ParsedReport, ParsedTradeline } from './types';

/**
 * Exact readers for the bureaus' own free-report layouts, as the text comes out of the PDF that
 * AnnualCreditReport.com hands out. Each value is taken from a fixed label and filed into a fixed field: no AI, no
 * guessing. Layouts we don't know return null and fall through to the general parser / AI reading.
 *
 *   Experian    "Annual Credit Report - Experian" print (usa.experian.com/acr/printReport)
 *   Equifax     "Credit Report … Confirmation # … EFX-ACR" disclosure
 */

export type BureauLayout = 'experian_acr' | 'equifax_acr';

export function detectLayout(text: string): BureauLayout | null {
  const head = text.slice(0, 20_000);
  if (/usa\.experian\.com\/acr|Annual Credit Report - Experian/i.test(head) && /^Account Name /m.test(text)) return 'experian_acr';
  if (/EFX-ACR|equifax\.com\/personal/i.test(head) && /^Account Number: \*/m.test(text)) return 'equifax_acr';
  return null;
}

export function parseBureauLayout(text: string): ParsedReport | null {
  const layout = detectLayout(text);
  if (layout === 'experian_acr') return parseExperianAcr(text);
  if (layout === 'equifax_acr') return parseEquifaxAcr(text);
  return null;
}

// ------------------------------------------------------------------ shared helpers

const HIGH = 0.95;
const meta = (line: string, ok = true): FieldMeta => ({ confidence: ok ? HIGH : 0.2, snippet: maskSnippet(line) });
const clean = (s: string | undefined | null): string | null => {
  const v = (s ?? '').trim();
  return !v || v === '-' || /^none$/i.test(v) ? null : v;
};
/** Last 4 characters that identify the account, ignoring the bureau's X / * masking on either end. */
export function last4(raw: string | null): string | null {
  if (!raw) return null;
  const core = raw.replace(/[^0-9A-Za-z]/g, '').replace(/^X+|X+$/gi, '');
  return core ? core.slice(-4).toUpperCase() : null;
}

function finish(t: Omit<ParsedTradeline, 'confidence'>): ParsedTradeline {
  const weakest = Object.values(t.field_meta).reduce((m, f) => Math.min(m, f.confidence), 1);
  return { ...t, confidence: Math.min(weakest, t.bureau ? 1 : 0.3) };
}

// ------------------------------------------------------------------ Experian

const EXP_FOOTER = [/^\d{1,2}\/\d{1,2}\/\d{2}, \d{1,2}:\d{2} [AP]M .*Experian/i, /^https?:\/\/usa\.experian\.com\//i];
const EXP_LABELS = ['Account Number', 'Account Type', 'Responsibility', 'Interest Type', 'Date Opened', 'Status Updated', 'Status', 'Balance Updated', 'Balance', 'Recent Payment', 'Monthly Payment', 'Original Balance', 'Highest Balance', 'Credit Limit', 'Terms', 'On Record Until', 'Original Creditor'];
const DWELLING = /^(single family|apartment|complex|apartment complex|multifamily|condominium|mobile home|business|rural route|post office box|military|unknown)$/i;

/** Lines that end the previous inquiry's purpose text, a page's intro, or an account's grid: a name never contains them. */
const INQ_STOP = /^(until [A-Z][a-z]{2} \d{4}\.|.*\. This|inquiry is|scheduled to|continue on record|Hard Inquiries|No public records reported\.?|Current \/ Terms met|—|Hard inquiries are.*|.*inquiries are displayed.*|at least two years\.?)$/i;

export function parseExperianAcr(text: string): ParsedReport {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => !EXP_FOOTER.some((re) => re.test(l)));
  const out: ParsedReport = { bureau: 'experian', reportDate: null, tradelines: [], inquiries: [], publicRecords: [], identity: [], scores: [], warnings: [] };
  const gen = lines.find((l) => /^Date Generated /.test(l));
  if (gen) out.reportDate = normalizeDate(gen.replace(/^Date Generated /, ''));

  // Personal information: names and addresses (employer lines wrap unpredictably and are left to the reviewer).
  const namesAt = lines.indexOf('Names');
  const addrAt = lines.indexOf('Addresses');
  if (namesAt >= 0) {
    let cur: string[] = [];
    for (let i = namesAt + 1; i < lines.length && i < (addrAt > namesAt ? addrAt : namesAt + 60); i++) {
      const l = lines[i]!;
      if (/^Name ID #/.test(l)) { if (cur.length) out.identity.push({ bureau: 'experian', kind: 'name', value: cur.join(' ').slice(0, 300) }); cur = []; }
      else if (l) cur.push(l);
    }
  }
  if (addrAt >= 0) {
    let cur: string[] = [];
    let skipping = false;
    for (let i = addrAt + 1; i < lines.length; i++) {
      const l = lines[i]!;
      if (/^(Accounts|Year of Birth|Phone Numbers|Employers|Spouse or Co-Applicant)$/.test(l)) break;
      if (l === 'Address ID') { if (cur.length) out.identity.push({ bureau: 'experian', kind: 'address', value: cur.join(' ').replace(/- (\d{4})\b/, '-$1').slice(0, 300) }); cur = []; skipping = true; continue; }
      if (skipping && (/^#\d+$/.test(l) || DWELLING.test(l))) continue;
      skipping = false;
      if (l) cur.push(l);
    }
  }
  out.warnings.push('Employers and phone numbers on the Experian report were not imported; check them on the original if they matter.');

  // Accounts: each starts at "Account Name"; values are the first line for each label inside the block.
  const softAt = lines.indexOf('Soft Inquiries');
  const end = softAt > 0 ? softAt : lines.length;
  const starts = lines.map((l, i) => (/^Account Name /.test(l) && i < end ? i : -1)).filter((i) => i >= 0);
  starts.forEach((s, k) => {
    const block = lines.slice(s, k + 1 < starts.length ? starts[k + 1] : end);
    const got: Record<string, { v: string; line: string }> = {};
    for (const line of block) {
      for (const label of EXP_LABELS) {
        if (got[label]) continue;
        if (line.startsWith(label + ' ') || line === label) {
          // "Status Updated" must not be read as "Status", nor "Balance Updated" as "Balance".
          if (label === 'Status' && line.startsWith('Status Updated')) continue;
          if (label === 'Balance' && /^Balance (Updated|Histories)/.test(line)) continue;
          got[label] = { v: line.slice(label.length).trim(), line };
          break;
        }
      }
    }
    const name = block[0]!.replace(/^Account Name /, '').trim();
    const m: Record<string, FieldMeta> = { creditor_name: meta(block[0]!) };
    const take = (label: string, key: string, max = 100): string | null => {
      const g = got[label]; const v = clean(g?.v);
      if (!g || !v) return null;
      m[key] = meta(g.line); return v.slice(0, max);
    };
    const money = (label: string, key: string): number | null => {
      const g = got[label]; const v = clean(g?.v);
      if (!g || !v) return null;
      const n = parseMoneyToCents(v.replace(/ as of .*$/, '')); m[key] = meta(g.line, n !== null); return n;
    };
    const date = (label: string, key: string): string | null => {
      const g = got[label]; const v = clean(g?.v);
      if (!g || !v) return null;
      const n = normalizeDate(v); m[key] = meta(g.line, n !== null); return n;
    };
    const acct = got['Account Number'];
    // Experian usually prints the first digits and masks the end ("434813XXXXXX"): those digits are not the last 4,
    // so nothing is stored rather than a number that would never match another bureau's last 4.
    const acctRaw = clean(acct?.v);
    const l4 = acctRaw && /[Xx*]$/.test(acctRaw) ? null : last4(acctRaw);
    if (acct && l4) m.account_last4 = meta(acct.line);
    const type = take('Account Type', 'account_type');
    const status = take('Status', 'account_status', 100);
    const guideLine = block.find((l) => /^(Collection|Charge off|\d+ days past due|Past due).* as of /i.test(l));
    const pastDue = status && /past due/i.test(status) ? status.replace(/^[^.]*\.\s*/, '').slice(0, 100) : null;
    // The payment history guide ("30 days past due as of Oct 2026") is the bureau's own summary of late months.
    const lateGuide = guideLine && /days past due|charge off/i.test(guideLine) ? guideLine.slice(0, 100) : null;
    if (pastDue) m.payment_status = m.account_status!;
    else if (lateGuide) m.payment_status = meta(guideLine!);
    const isCollection = /collection/i.test(type ?? '') || /^collection/i.test(status ?? '');

    // Remarks: what the bureau itself says about the account, in its words.
    const notes: string[] = [];
    const resp = clean(got['Responsibility']?.v); if (resp && !/^individual$/i.test(resp)) notes.push(`Responsibility: ${resp}`);
    const guide = block.find((l) => /^(Collection|Charge off|\d+ days past due|Past due).* as of /i.test(l)); if (guide) notes.push(guide);
    const ci = block.findIndex((l) => l === 'Comment');
    if (ci >= 0) {
      const cur: string[] = [];
      for (let i = ci + 1; i < block.length && i < ci + 12; i++) {
        const l = block[i]!;
        if (/^Previous:/.test(l) || /^[A-Z][a-z]{2} \d{4} to /.test(l)) break;
        if (!/^Current:$/.test(l)) cur.push(l);
      }
      if (cur.length) notes.push(cur.join(' '));
    }
    const until = clean(got['On Record Until']?.v); if (until) notes.push(`On record until ${until}`);
    const terms = clean(got['Terms']?.v); if (terms) notes.push(`Terms: ${terms}`);
    if (notes.length) m.remarks = meta(guide ?? block[0]!);

    out.tradelines.push(finish({
      bureau: 'experian',
      item_type: isCollection ? 'collection' : 'tradeline',
      creditor_name: name.slice(0, 200),
      original_creditor: take('Original Creditor', 'original_creditor', 200),
      account_last4: l4,
      account_type: type,
      account_status: status,
      payment_status: pastDue ?? lateGuide,
      balance_cents: money('Balance', 'balance_cents'),
      credit_limit_cents: money('Credit Limit', 'credit_limit_cents'),
      high_balance_cents: money('Highest Balance', 'high_balance_cents') ?? money('Original Balance', 'high_balance_cents'),
      date_opened: date('Date Opened', 'date_opened'),
      date_reported: date('Balance Updated', 'date_reported') ?? date('Status Updated', 'date_reported'),
      date_of_first_delinquency: null,
      payment_history: null,
      remarks: notes.length ? notes.join(' · ').slice(0, 300) : null,
      field_meta: m,
    }));
  });

  // Hard inquiries only (soft ones are not disputable and do not affect scores).
  const hardAt = lines.indexOf('Hard Inquiries');
  if (hardAt >= 0) {
    for (let i = hardAt + 1; i < end; i++) {
      if (lines[i] !== 'Inquired on') continue;
      const name: string[] = [];
      for (let j = i - 1; j > hardAt && name.length < 4; j--) {
        const l = lines[j]!;
        if (!l || INQ_STOP.test(l)) break;
        name.unshift(l);
      }
      if (name.length) out.inquiries.push({ bureau: 'experian', name: name.join(' ').slice(0, 200), inquiry_date: normalizeDate(lines[i + 1] ?? '') } satisfies ParsedInquiry);
    }
  }
  return out;
}

// ------------------------------------------------------------------ Equifax

const EFX_FOOTER = /^\d{6,}-DISC Page \d+ of \d+/;

export function parseEquifaxAcr(text: string): ParsedReport {
  // Drop each page's running header: footer line, "Prepared for:", the name, "Date: …", "Confirmation # …".
  const raw = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim());
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i]!;
    if (EFX_FOOTER.test(l)) continue;
    if (l === 'Prepared for:') { i++; continue; }
    if (/^Confirmation # \d+$/.test(l)) continue;
    if (/^Date: [A-Z][a-z]+ \d{1,2}, \d{4}$/.test(l)) continue;
    lines.push(l);
  }
  const out: ParsedReport = { bureau: 'equifax', reportDate: null, tradelines: [], inquiries: [], publicRecords: [], identity: [], scores: [], warnings: [] };
  const rd = lines.find((l) => /^Report Date /.test(l)) ?? raw.find((l) => /^Date: /.test(l));
  if (rd) out.reportDate = normalizeDate(rd.replace(/^(Report Date|Date:) /, ''));

  // Personal information: current name and address, former addresses.
  const pi = lines.findIndex((l) => /^Creditors use your personal information/.test(l));
  if (pi >= 0) {
    if (lines[pi + 1]) out.identity.push({ bureau: 'equifax', kind: 'name', value: lines[pi + 1]!.slice(0, 300) });
    if (lines[pi + 2] && /\d/.test(lines[pi + 2]!)) out.identity.push({ bureau: 'equifax', kind: 'address', value: lines[pi + 2]!.slice(0, 300) });
    const fa = lines.findIndex((l, i) => i > pi && /^Former Address\(es\):/.test(l));
    if (fa >= 0) {
      let cur: string[] = [];
      for (let i = fa + 1; i < lines.length && !/^Consumer Statement:/.test(lines[i]!); i++) {
        const l = lines[i]!;
        if (/^none$/i.test(l) || /^\(\d{3}\)/.test(l)) continue;
        cur.push(l);
        if (/\b\d{5}(-\d{4})?$/.test(l)) { out.identity.push({ bureau: 'equifax', kind: 'address', value: cur.join(' ').slice(0, 300) } satisfies ParsedIdentity); cur = []; }
      }
    }
  }
  out.warnings.push('Former names and employers on the Equifax report were not imported; check them on the original if they matter.');

  const at = (re: RegExp, from = 0) => lines.findIndex((l, i) => i >= from && re.test(l));
  const accountsAt = at(/^Credit Accounts$/);
  const collectionsAt = at(/^Collections$/, accountsAt);
  const inquiriesAt = at(/^Inquiries$/, collectionsAt > 0 ? collectionsAt : accountsAt);
  const field = (s: string, label: string, next: string[]): string | null => {
    const i = s.indexOf(label + ':');
    if (i < 0) return null;
    let v = s.slice(i + label.length + 1);
    for (const n of next) { const j = v.indexOf(n + ':'); if (j >= 0) v = v.slice(0, j); }
    return clean(v.replace(/\|\s*$/, '').trim().replace(/\|$/, '').trim());
  };

  // Every account (and collection) is anchored on its "Account Number: *1234" line: two lines above is the name.
  const anchors = lines.map((l, i) => (/^Account Number: /.test(l) && i > accountsAt ? i : -1)).filter((i) => i >= 0);
  anchors.forEach((a, k) => {
    const blockEnd = Math.min(k + 1 < anchors.length ? anchors[k + 1]! - 2 : lines.length, inquiriesAt > a ? inquiriesAt : lines.length);
    const block = lines.slice(a - 2, blockEnd);
    const line = (label: string) => block.find((l) => l.includes(label + ':')) ?? block[2]!;
    const m: Record<string, FieldMeta> = { creditor_name: meta(block[0]!) };
    const isCollection = collectionsAt > 0 && a > collectionsAt;
    function get(label: string, next: string[], key: string | undefined, kind: 'money'): number | null;
    function get(label: string, next: string[], key?: string, kind?: 'text' | 'date'): string | null;
    function get(label: string, next: string[], key?: string, kind: 'text' | 'money' | 'date' = 'text'): string | number | null {
      const l = block.find((x) => x.includes(label + ':'));
      if (!l) return null;
      const v = field(l, label, next);
      if (!v) return null;
      if (kind === 'money') { const n = parseMoneyToCents(v); if (key) m[key] = meta(l, n !== null); return n; }
      if (kind === 'date') { const n = normalizeDate(v); if (key) m[key] = meta(l, n !== null); return n; }
      if (key) m[key] = meta(l);
      return v.slice(0, 200);
    };
    const name = block[0]!.replace(/ - Closed$/, '').trim();
    const closedTag = / - Closed$/.test(block[0]!);
    const num = field(block[2]!, 'Account Number', ['Owner']);
    const l4 = last4(num);
    if (l4) m.account_last4 = meta(block[2]!);
    const owner = field(block[2]!, 'Owner', ['Credit Limit']);
    const notes: string[] = [];
    if (owner && !/^individual/i.test(owner)) notes.push(`Owner: ${owner}`);

    if (!isCollection) {
      const statusRaw = get('Status', ['Date Opened']);
      const pastDue = get('Amount Past Due', ['Deferred Payment Start Date']);
      const chargeOff = get('Charge Off Amount', ['Balloon Payment Amount']);
      const dateClosed = get('Date Closed', ['Balloon Payment Date']);
      const activity = get('Activity Designator', ['Narrative Code(s)']);
      if (pastDue) notes.push(`Amount past due: ${pastDue}`);
      if (chargeOff) notes.push(`Charge-off amount: ${chargeOff}`);
      if (activity) notes.push(activity);
      const ni = block.findIndex((l) => l === 'Narrative Code Narrative Code Description');
      if (ni >= 0) for (let i = ni + 1; i < block.length && /^\d{3} \S/.test(block[i]!); i++) notes.push(block[i]!.replace(/^\d{3} /, ''));
      const ph = block.findIndex((l) => /^Year Jan Feb Mar/.test(l));
      const hist: string[] = [];
      if (ph >= 0) for (let i = ph + 1; i < block.length && /^(19|20)\d{2}\b/.test(block[i]!); i++) hist.push(block[i]!);
      if (hist.length) m.payment_history = meta(hist[0]!);
      const account_status = closedTag || dateClosed ? `Closed${dateClosed ? ` ${dateClosed}` : ''}` : 'Open';
      m.account_status = meta(closedTag ? block[0]! : line('Date Closed'));
      out.tradelines.push(finish({
        bureau: 'equifax', item_type: 'tradeline', creditor_name: name.slice(0, 200), original_creditor: null, account_last4: l4,
        account_type: get('Loan/Account Type', ['Status'], 'account_type'),
        account_status,
        payment_status: statusRaw ? (m.payment_status = meta(line('Status')), statusRaw.slice(0, 100)) : null,
        balance_cents: get('Balance', [], 'balance_cents', 'money'),
        credit_limit_cents: get('Credit Limit', ['High Credit'], 'credit_limit_cents', 'money'),
        high_balance_cents: get('High Credit', [], 'high_balance_cents', 'money'),
        date_opened: get('Date Opened', ['Date of 1st Delinquency'], 'date_opened', 'date'),
        date_reported: get('Date Reported', ['Balance'], 'date_reported', 'date'),
        date_of_first_delinquency: get('Date of 1st Delinquency', ['Terms Frequency'], 'date_of_first_delinquency', 'date'),
        payment_history: hist.length ? hist.join('; ').slice(0, 120) : null,
        remarks: notes.length ? notes.join(' · ').slice(0, 300) : null,
        field_meta: m,
      }));
    } else {
      const statusLine = block.find((l) => /Status as of [^:]+:/.test(l));
      const st = statusLine ? clean(statusLine.replace(/^.*Status as of [^:]+:\s*/, '')) : null;
      if (statusLine && st) m.account_status = meta(statusLine);
      const balLine = block.find((l) => /Balance as of [^:]+:/.test(l));
      const bal = balLine ? parseMoneyToCents((/Balance as of [^:]+:\s*(\$[\d,.]+)/.exec(balLine)?.[1]) ?? '') : null;
      if (balLine) m.balance_cents = meta(balLine, bal !== null);
      const addl = get('Additional Information', []);
      const cls = get('Creditor Classification', []);
      if (cls) notes.push(`Classification: ${cls}`);
      if (addl) notes.push(addl);
      const assignedLine = block.find((l) => /^Assigned: /.test(l));
      const assigned = assignedLine ? /^Assigned: (\S+)/.exec(assignedLine)?.[1] : null;
      if (assigned && assigned !== 'None') notes.push(`Assigned to collector ${assigned}`);
      out.tradelines.push(finish({
        bureau: 'equifax', item_type: 'collection', creditor_name: name.slice(0, 200),
        original_creditor: get('Original Creditor', [], 'original_creditor'),
        account_last4: l4, account_type: 'Collection', account_status: st ? `Collection: ${st}` : 'Collection', payment_status: null,
        balance_cents: bal,
        credit_limit_cents: null,
        high_balance_cents: get('Amount', ['Original Creditor'], 'high_balance_cents', 'money'),
        date_opened: null,
        date_reported: get('Collection Reported', ['Amount'], 'date_reported', 'date'),
        date_of_first_delinquency: get('Date of 1st Delinquency', ['Last Payment Date'], 'date_of_first_delinquency', 'date'),
        payment_history: null,
        remarks: notes.length ? notes.join(' · ').slice(0, 300) : null,
        field_meta: m,
      }));
    }
  });

  // Inquiries: name line, address, phone, then "Hard 06/30/2025[, …]". Only hard inquiries are imported.
  if (inquiriesAt >= 0) {
    let state: 'intro' | 'name' | 'body' = 'intro';
    let name = '';
    for (let i = inquiriesAt; i < lines.length; i++) {
      const l = lines[i]!;
      if (/^A Summary of Your Rights/.test(l)) break;
      if (l === 'Inquiries') { state = 'intro'; continue; }
      if (/^Company Information Inquiry Type/.test(l)) { state = 'name'; continue; }
      if (state === 'intro' || !l) continue;
      if (state === 'name') { name = l; state = 'body'; continue; }
      const t = /^(Hard|Soft)\s+(.+)$/.exec(l);
      if (t) {
        if (t[1] === 'Hard') for (const d of t[2]!.split(/[,\s]+/).filter(Boolean)) out.inquiries.push({ bureau: 'equifax', name: name.slice(0, 200), inquiry_date: normalizeDate(d) });
        state = 'name';
      }
    }
  }
  return out;
}
