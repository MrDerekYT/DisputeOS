import { maskSnippet, normalizeDate, parseMoneyToCents } from './parser';
import type { FieldMeta, ParsedIdentity, ParsedInquiry, ParsedReport, ParsedTradeline } from './types';

/**
 * Exact readers for the bureaus' own free-report layouts, as the text comes out of the PDF that
 * AnnualCreditReport.com hands out. Each value is taken from a fixed label and filed into a fixed field: no AI, no
 * guessing. Layouts we don't know return null and fall through to the general parser / AI reading.
 *
 *   Experian    "Annual Credit Report - Experian" print (usa.experian.com/acr/printReport)
 *   Equifax     "Credit Report … Confirmation # … EFX-ACR" disclosure
 *   TransUnion  "View Your Report | TransUnion Credit Report" print (annualcreditreport.transunion.com)
 */

export type BureauLayout = 'experian_acr' | 'equifax_acr' | 'transunion_acr';

/** Text only TransUnion's own online report carries. A file that merely names the bureau does not match. */
const TU_SIGNATURE = /annualcreditreport\.transunion\.com|Payment\/Remarks Key|Personal Credit Report for/i;

export function detectLayout(text: string): BureauLayout | null {
  const head = text.slice(0, 20_000);
  if (/usa\.experian\.com\/acr|Annual Credit Report - Experian/i.test(head) && /^Account Name /m.test(text)) return 'experian_acr';
  if (/EFX-ACR|equifax\.com\/personal/i.test(head) && /^Account Number: \*/m.test(text)) return 'equifax_acr';
  if (/trans\s?union/i.test(head) && TU_SIGNATURE.test(text)) return 'transunion_acr';
  return null;
}

export function parseBureauLayout(text: string): ParsedReport | null {
  const layout = detectLayout(text);
  if (layout === 'experian_acr') return parseExperianAcr(text);
  if (layout === 'equifax_acr') return parseEquifaxAcr(text);
  if (layout === 'transunion_acr') return parseTransUnionAcr(text);
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

/**
 * The print's page header and footer. The mark between the hour and the minutes is not always a colon in the extracted
 * text (some fonts give a private-use character there, some nothing), so any one mark is accepted.
 */
const EXP_FOOTER = [/^\d{1,2}\/\d{1,2}\/\d{2,4}, \d{1,2}[^\d\s]?\d{2} [AP]M .*Experian/i, /^https?:\/\/usa\.experian\.com\//i];
const EXP_LABELS = ['Account Number', 'Account Type', 'Responsibility', 'Interest Type', 'Date Opened', 'Status Updated', 'Status', 'Balance Updated', 'Balance', 'Recent Payment', 'Monthly Payment', 'Original Balance', 'Highest Balance', 'Credit Limit', 'Terms', 'On Record Until', 'Original Creditor'];
const DWELLING = /^(single family|apartment|complex|apartment complex|multifamily|condominium|mobile home|business|rural route|post office box|military|unknown)$/i;

/**
 * Lines that end the previous inquiry (its purpose text, or its "Inquired on" date when nothing follows it), a page's
 * intro, or an account's grid: a name never contains them.
 */
const INQ_STOP = /^(until [A-Z][a-z]{2} \d{4}\.|.*\. This|inquiry is|scheduled to|continue on record|Inquired on|\d{1,2}\/\d{1,2}\/\d{4}|Hard Inquiries|No public records reported\.?|Current \/ Terms met|—|Hard inquiries are.*|.*inquiries are displayed.*|at least two years\.?)$/i;

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

  // The report states its own totals on the first page ("18 Accounts 0 Public Records 3 Hard Inquiries"; an extractor
  // may drop the spaces or give each count its own line). What was read is checked against them, so an account or an
  // inquiry that was not read does not pass unnoticed.
  const listed = EXP_TOTALS.exec(lines.slice(0, 200).join(' '));
  if (listed) {
    const [accounts, records, hard] = [Number(listed[1]), Number(listed[2]), Number(listed[3])];
    if (accounts !== out.tradelines.length) out.warnings.push(countMismatch(accounts, 'account', 'accounts', out.tradelines.length));
    if (hard !== out.inquiries.length) out.warnings.push(countMismatch(hard, 'hard inquiry', 'hard inquiries', out.inquiries.length));
    if (records > 0) out.warnings.push(`The report lists ${records} public record${records === 1 ? '' : 's'}. Public records are not imported from this layout: add ${records === 1 ? 'it' : 'them'} from the original by hand.`);
  }
  return out;
}

const EXP_TOTALS = /\b(\d+)\s*Accounts?\s*(\d+)\s*Public Records?\s*(\d+)\s*Hard Inquir(?:y|ies)\b/i;

/** "The report lists 18 accounts; 17 were read. Compare with the original before approving." */
export function countMismatch(listed: number, one: string, many: string, read: number): string {
  return `The report lists ${listed} ${listed === 1 ? one : many}; ${read} ${read === 1 ? 'was' : 'were'} read. Compare with the original before approving.`;
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

// ------------------------------------------------------------------ TransUnion

/**
 * Every TransUnion field is held just below REVIEW_THRESHOLD, so a person confirms each value against the original.
 * The reader was built from the layout of TransUnion's online report and tested on generated files in that layout,
 * not yet on a real file read through this PDF extractor. Raise it to 0.95 once real files have been checked.
 */
export const TRANSUNION_FIELD_CONFIDENCE = 0.75;
export const TRANSUNION_CHECK_WARNING = 'The TransUnion reader is new and has been tested on sample files only: check every value against the original report before approving.';

/**
 * The print time in the page header ("11/23/26, 3:05 PM"). The mark between the hour and the minutes is not always a
 * colon in the extracted text (some fonts give a private-use character, some nothing), so any one mark is accepted.
 */
const TU_PRINT_TIME = String.raw`\d{1,2}\/\d{1,2}\/\d{2,4},? \d{1,2}[^\d\s]?\d{2} ?[AP]M`;
/**
 * Page header and footer text of the browser print, wherever it lands: pdf.js can put it in the middle of an entry.
 * The footer is the page's address (annualcreditreport.transunion.com, or another transunion.com site) and "7/16".
 */
const TU_FURNITURE = [
  /https?:\/\/[\w.-]*transunion\.com\/\S*(?: \d{1,3}\/\d{1,3})?/gi,
  new RegExp(String.raw`(?:${TU_PRINT_TIME} )?View Your Report \| TransUnion Credit Report`, 'gi'),
];
/** What can be left of a header or footer once its text is gone: a lone "7/16" page mark, or the print time. */
const TU_PAGE_MARK = new RegExp(String.raw`^(?:\d{1,3}\/\d{1,3}|${TU_PRINT_TIME})$`, 'i');
const TU_SECTION = /^(?:Personal Information|Accounts|Accounts with Adverse Information|Adverse Accounts|Satisfactory Accounts|Public Records|Inquiries|Regular Inquiries|Promotional Inquiries|Account Review Inquiries|Consumer Statements?|Additional Information|Summary of Rights)$/i;

/**
 * The rows of one account, longest first so "High Balance (Hist.)" is never read as "High Balance". Not every row is
 * imported: the others are listed so that a row's value is never taken for part of the row before it.
 */
const TU_LABELS = [
  'Estimated month and year', 'Date Placed for Collection', 'Placed for collection', 'High Balance (Hist.)', 'Credit Limit (Hist.)', 'Maximum Delinquency', 'Last Payment Made',
  'Payment Received', 'Monthly Payment', 'Original Creditor', 'Original Amount', 'Original Balance', 'Responsibility', 'Account Type', 'Date Updated', 'Date Opened',
  'Date Closed', 'Date Paid', 'High Balance', 'Credit Limit', 'Pay Status', 'Loan Type', 'Past Due', 'Balance', 'Address', 'Remarks', 'Phone', 'Terms',
] as const;
type TuLabel = (typeof TU_LABELS)[number];
const tuLabelOf = (line: string): TuLabel | null => TU_LABELS.find((k) => line === k || line.startsWith(`${k} `) || line.startsWith(`${k}:`)) ?? null;

/** A history row that ran onto the next line: "$612 from 08/2026 to 09/2026". */
const TU_HIST_MORE = /^(?:\$|\d{2}\/\d{4}\b|to\b|from\b)/i;
const tuMeta = (line: string, ok = true): FieldMeta => ({ confidence: ok ? TRANSUNION_FIELD_CONFIDENCE : 0.2, snippet: maskSnippet(line) });
/** TransUnion wraps adverse values in >brackets< and prints "---" for nothing. */
const tuClean = (s: string | undefined | null): string | null => {
  const v = (s ?? '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  return !v || /^-+$/.test(v) || /^none$/i.test(v) ? null : v;
};

/** Text with the print's page furniture removed, one trimmed line per entry, no empty lines. */
function tuLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // Spaces first (the header can carry a no-break space before AM/PM), so the patterns only meet plain ones.
    let l = raw.replace(/\s+/g, ' ');
    for (const re of TU_FURNITURE) l = l.replace(re, ' ');
    l = l.replace(/\s+/g, ' ').trim();
    if (l && !TU_PAGE_MARK.test(l)) out.push(l);
  }
  return out;
}

/**
 * One row of an account. pdf.js gives a row either as "Label value" on one line or as the label on one line and the
 * value on the next, depending on how the page was laid out, so both are read. Only rows known to wrap take more
 * lines: `hist` (the two "(Hist.)" rows) while the line continues the list, `text` (Remarks) until the next label.
 */
function tuField(info: string[], label: TuLabel, more?: 'hist' | 'text'): { v: string; line: string } | null {
  for (let i = 0; i < info.length; i++) {
    if (tuLabelOf(info[i]!) !== label) continue;
    let v = info[i]!.slice(label.length).replace(/^:/, '').trim();
    let j = i + 1;
    if (!v && j < info.length && !tuLabelOf(info[j]!)) v = info[j++]!;
    const free = (): boolean => j < info.length && !tuLabelOf(info[j]!);
    if (more) {
      for (let n = 0; n < TU_MORE_LINES[more] && free() && (more === 'text' || TU_HIST_MORE.test(info[j]!)); n++, j++) v += ` ${info[j]!}`;
    } else {
      // An adverse value is printed in >brackets<: one that opens and does not close ran onto the next line.
      for (let n = 0; n < 3 && /^>[^<]*$/.test(v) && free(); n++, j++) v += ` ${info[j]!}`;
    }
    return { v: v.trim(), line: `${label} ${v}`.trim() };
  }
  return null;
}
/** Lines a wrapped row may run on for: a "(Hist.)" row can list two years of months, Remarks is a sentence or two. */
const TU_MORE_LINES = { hist: 60, text: 4 } as const;

/** "$300 from 05/2026 to 06/2026; $500 from 07/2026 to 09/2026": the amount whose period ends last, whatever the order. */
function tuLatestAmount(v: string): number | null {
  let best: { ends: string; cents: number } | null = null;
  for (const x of v.matchAll(/\$\s?([\d,]+(?:\.\d{1,2})?)\s*from\s+\d{2}\/\d{4}\s+to\s+(\d{2})\/(\d{4})/gi)) {
    const cents = parseMoneyToCents(x[1]!);
    const ends = `${x[3]}-${x[2]}`;
    if (cents !== null && (!best || ends >= best.ends)) best = { ends, cents };
  }
  return best ? best.cents : null;
}

/** "FIRST BANK CARD 411100002468****" is the name and the masked number. The mask can also be in front, or stand apart. */
export function tuNameAndNumber(head: string): { name: string; number: string | null } {
  const tokens = head.replace(/[<>]/g, ' ').split(' ').filter(Boolean);
  const last = tokens[tokens.length - 1] ?? '';
  const prev = tokens[tokens.length - 2] ?? '';
  let number: string | null = null;
  if (tokens.length > 1 && last.includes('*')) {
    number = tokens.pop()!;
    // "411100002468 ****": the digits and the mask came out as two words.
    if (/^\*+$/.test(number) && tokens.length > 1 && /^[0-9A-Z]*\d[0-9A-Z]*$/.test(prev) && prev.length >= 4) number = tokens.pop()! + number;
  } else if (tokens.length > 2 && /^\*+$/.test(prev) && /^[0-9A-Za-z]+$/.test(last)) {
    number = tokens.splice(-2).join('');
  } else if (tokens.length > 1 && /^\d{6,}$/.test(last)) {
    number = tokens.pop()!;
  }
  return { name: tokens.join(' '), number };
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TU_MONTH = /\b(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? (\d{4})|(0[1-9]|1[0-2])\/(\d{4}))\b/g;
/** TransUnion's rating codes, written as its own key prints them. */
const TU_RATINGS: Record<string, string> = { OK: 'OK', 'N/R': 'N/R', X: 'x', 30: '30', 60: '60', 90: '90', 120: '120', COL: 'COL', VS: 'vs', RPO: 'RPO', 'C/O': 'c/o', FC: 'FC' };
const TU_ON_TIME = new Set(['OK', 'N/R', 'x']);
const TU_LATE_ORDER = ['30', '60', '90', '120', 'COL', 'c/o', 'RPO', 'FC', 'vs'];
/** Stored when every reported month is on time. No digits on purpose: a digit here could be read as a late code. */
export const TU_NO_LATES = 'No late payments in the months reported';

/**
 * The payment history grid as one short line: only the late months, in the bureau's codes ("Jul 2026 30; Aug 2026 60").
 * Months and ratings are paired by the order they appear in, which holds whether pdf.js reads the grid month by month
 * or row by row. When they cannot be paired, the late codes are kept without months rather than guessed.
 */
export function tuPaymentHistory(hist: string[]): string | null {
  const joined = hist.join(' ');
  const months = [...joined.matchAll(TU_MONTH)].map((m) => (m[1] ? `${m[1]} ${m[2]}` : `${MON[Number(m[3]) - 1]} ${m[4]}`));
  const tokens = joined.split(' ');
  const ratings: string[] = [];
  // The word after "Remarks" is a remark code (some share letters with a rating), never a rating.
  tokens.forEach((t, i) => { const r = TU_RATINGS[t.toUpperCase()]; if (r && tokens[i - 1] !== 'Remarks') ratings.push(r); });
  if (!ratings.length) return null;
  if (months.length === ratings.length) {
    const lates = months.map((m, i) => `${m} ${ratings[i]!}`).filter((_, i) => !TU_ON_TIME.has(ratings[i]!));
    if (!lates.length) return TU_NO_LATES;
    let shown = lates.length;
    const text = () => lates.slice(0, shown).join('; ') + (shown < lates.length ? `; +${lates.length - shown} more` : '');
    while (shown > 1 && text().length > 120) shown--;
    return text().slice(0, 120);
  }
  const codes = TU_LATE_ORDER.filter((c) => ratings.includes(c));
  return codes.length ? `Late codes reported: ${codes.join(', ')} (months not matched; see the original)` : null;
}

const TU_INQUIRY_TYPE = /^(?:Individual|Joint|Participant|Authorized User|Co-?signer|Co-?maker|Shared|Undesignated)\b/i;

/**
 * Hard ("Regular") inquiries only: one row per requested date. Promotional and account-review inquiries are soft.
 * `dates` is how many dates the section prints, so the caller can tell a section that was read from one that was not.
 */
function tuInquiries(lines: string[]): { rows: ParsedInquiry[]; dates: number } {
  const start = lines.indexOf('Regular Inquiries');
  if (start < 0) return { rows: [], dates: 0 };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (TU_SECTION.test(lines[i]!) || /^Should you wish to contact TransUnion/i.test(lines[i]!)) { end = i; break; }
  }
  const sec = lines.slice(start + 1, end);
  const heads: { at: number; len: number }[] = [];
  for (let i = 0; i < sec.length; i++) {
    if (/^Location Requested On(?: Phone)?$/.test(sec[i]!)) heads.push({ at: i, len: 1 });
    else if (sec[i] === 'Location' && sec[i + 1] === 'Requested On') heads.push({ at: i, len: sec[i + 2] === 'Phone' ? 3 : 2 });
  }
  const out: ParsedInquiry[] = [];
  // Where the lines of the next company name begin, and whether that point is certain (after the "Name" label or a
  // finished entry). When it is not, only the line right above the column headings is taken as the name.
  const nameLabel = sec.indexOf('Name');
  let nameFrom = heads[0] && nameLabel >= 0 && nameLabel < heads[0].at ? nameLabel + 1 : 0;
  let certain = nameFrom > 0;
  heads.forEach((h, k) => {
    const next = heads[k + 1];
    const limit = next ? next.at : sec.length;
    const above = sec.slice(nameFrom, h.at).filter((l) => l !== 'Name' && !/^(?:Inquiry Type|Permissible Purpose)\b/.test(l));
    const name = (certain ? above.slice(-2) : above.slice(-1)).join(' ').trim();
    let typeAt = -1;
    for (let i = h.at + h.len; i < limit; i++) if (/^Inquiry Type\b/.test(sec[i]!)) { typeAt = i; break; }
    // Without an "Inquiry Type" row the entry runs to the next one, whose name is the line above its headings.
    const bodyEnd = typeAt >= 0 ? typeAt : next ? Math.max(next.at - 1, h.at + h.len) : sec.length;
    const dates = sec.slice(h.at + h.len, bodyEnd).join(' ').match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g) ?? [];
    if (name) {
      if (dates.length) for (const d of dates) out.push({ bureau: 'transunion', name: name.slice(0, 200), inquiry_date: normalizeDate(d) });
      else out.push({ bureau: 'transunion', name: name.slice(0, 200), inquiry_date: null });
    }
    if (typeAt >= 0) {
      let after = typeAt + 1;
      const onOwnLine = sec[typeAt] === 'Inquiry Type';
      // The type's value is the next line, unless that line is the only one left before the next entry's headings
      // and does not read as a type: then it is the next company's name.
      if (onOwnLine && after < limit && (limit - after >= 2 || !next || TU_INQUIRY_TYPE.test(sec[after]!))) after++;
      nameFrom = after; certain = true;
    } else {
      nameFrom = bodyEnd; certain = false;
    }
  });
  return { rows: out, dates: (sec.join(' ').match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g) ?? []).length };
}

const TU_PERSONAL_LABEL = /^(?:Credit Report Date|Social Security Number|Date of Birth|Name|Other Names?|Also Known As|Addresses|Current Address|Other Address|Previous Address|Former Address|Date Reported|Phone Numbers?|Employers?|Employer Name|Position|Occupation|Date Hired|Date Verified)\b/;

export function parseTransUnionAcr(text: string): ParsedReport {
  const lines = tuLines(text);
  const out: ParsedReport = { bureau: 'transunion', reportDate: null, tradelines: [], inquiries: [], publicRecords: [], identity: [], scores: [], warnings: [TRANSUNION_CHECK_WARNING] };

  /** The value of a personal-information row: on the label's line, or alone on the next one. */
  const valueAt = (i: number, label: string): string | null => {
    const same = lines[i]!.slice(label.length).replace(/^:/, '').trim();
    if (same) return same;
    const next = lines[i + 1];
    return next && !TU_PERSONAL_LABEL.test(next) && !TU_SECTION.test(next) ? next : null;
  };

  // Personal information: report date, names and addresses.
  const personalAt = lines.findIndex((l) => /^Personal Information$/i.test(l));
  const firstAccount = lines.findIndex((l) => l === 'Account Name' || l.startsWith('Account Name '));
  if (personalAt >= 0) {
    let personalEnd = lines.findIndex((l, i) => i > personalAt && (/^(?:Accounts|Public Records|Inquiries)$/i.test(l) || /^Payment\/Remarks Key/i.test(l)));
    if (personalEnd < 0) personalEnd = firstAccount >= 0 ? firstAccount : lines.length;
    for (let i = personalAt + 1; i < personalEnd; i++) {
      const l = lines[i]!;
      if (/^Credit Report Date\b/.test(l)) out.reportDate = normalizeDate(valueAt(i, 'Credit Report Date') ?? '') ?? out.reportDate;
      else if (l === 'Name' || (l.startsWith('Name ') && !/^Name ID\b/.test(l))) {
        const v = valueAt(i, 'Name');
        if (v) out.identity.push({ bureau: 'transunion', kind: 'name', value: v.slice(0, 300) } satisfies ParsedIdentity);
      } else {
        const a = /^(?:Current|Other|Previous|Former) Address\b/.exec(l);
        if (!a) continue;
        const parts: string[] = [];
        const same = l.slice(a[0].length).replace(/^:/, '').trim();
        if (same) parts.push(same);
        for (let j = i + 1; j < personalEnd && parts.length < 3 && !TU_PERSONAL_LABEL.test(lines[j]!) && !TU_SECTION.test(lines[j]!); j++) parts.push(lines[j]!);
        if (parts.length) out.identity.push({ bureau: 'transunion', kind: 'address', value: parts.join(' ').slice(0, 300) } satisfies ParsedIdentity);
      }
    }
  }
  if (!out.reportDate) {
    const created = lines.find((l) => /^Date Created\b/.test(l));
    if (created) out.reportDate = normalizeDate(created.replace(/^Date Created:?\s*/, ''));
  }
  out.warnings.push('Phone numbers and employers on the TransUnion report were not imported; check them on the original if they matter.');

  // Accounts: each starts at the "Account Name" label and runs to the next one, or to the next section heading.
  const starts = lines.map((l, i) => (l === 'Account Name' || l.startsWith('Account Name ') ? i : -1)).filter((i) => i >= 0);
  let unread = 0;
  starts.forEach((s, k) => {
    let e = k + 1 < starts.length ? starts[k + 1]! : lines.length;
    for (let i = s + 1; i < e; i++) if (TU_SECTION.test(lines[i]!)) { e = i; break; }
    const block = lines.slice(s, e);
    const infoAt = block.indexOf('Account Information');
    const headEnd = infoAt >= 0 ? infoAt : block[0] === 'Account Name' ? 2 : 1;
    const head = [block[0]!.slice('Account Name'.length).trim(), ...block.slice(1, Math.min(headEnd, 4))].filter(Boolean).join(' ');
    const { name, number } = tuNameAndNumber(head);
    if (!name || tuLabelOf(name)) { out.warnings.push('An account on the TransUnion report has no readable name and was not imported; check the original.'); return; }
    const histAt = block.findIndex((l, i) => i >= headEnd && l === 'Payment History');
    const info = block.slice(infoAt >= 0 ? infoAt + 1 : headEnd, histAt >= 0 ? histAt : block.length);
    const hist = histAt >= 0 ? block.slice(histAt + 1) : [];

    const m: Record<string, FieldMeta> = { creditor_name: tuMeta(head) };
    const text = (label: TuLabel, key?: string, more?: 'text'): string | null => {
      const g = tuField(info, label, more); const v = tuClean(g?.v);
      if (!g || !v) return null;
      if (key) m[key] = tuMeta(g.line);
      return v;
    };
    const money = (label: TuLabel, key: string): number | null => {
      const g = tuField(info, label); const v = tuClean(g?.v);
      if (!g || !v) return null;
      const n = parseMoneyToCents(v); m[key] = tuMeta(g.line, n !== null); return n;
    };
    const date = (label: TuLabel, key: string): string | null => {
      const g = tuField(info, label); const v = tuClean(g?.v);
      if (!g || !v) return null;
      const n = normalizeDate(v); m[key] = tuMeta(g.line, n !== null); return n;
    };
    /** A "(Hist.)" row lists amounts over time: `pick` takes the one that matters from them. */
    const fromHistory = (label: TuLabel, key: string, pick: (amounts: number[], row: string) => number): number | null => {
      const g = tuField(info, label, 'hist');
      if (!g || !tuClean(g.v)) return null;
      const amounts = [...g.v.matchAll(/\$\s?([\d,]+(?:\.\d{1,2})?)/g)].map((x) => parseMoneyToCents(x[1]!)).filter((n): n is number => n !== null);
      m[key] = tuMeta(g.line, amounts.length > 0);
      return amounts.length ? pick(amounts, g.v) : null;
    };

    // TransUnion masks the end of the number ("411100002468****"): those are not the last 4, so nothing is stored.
    const l4 = number && !/\*$/.test(number) ? last4(number) : null;
    if (l4) m.account_last4 = tuMeta(head);
    const type = text('Account Type');
    const loan = text('Loan Type');
    const typeLine = tuField(info, 'Account Type') ?? tuField(info, 'Loan Type');
    if (typeLine && (type || loan)) m.account_type = tuMeta(typeLine.line);
    const pay = text('Pay Status', 'payment_status');
    const original = text('Original Creditor', 'original_creditor');
    const remarks = text('Remarks', undefined, 'text');
    const closed = tuField(info, 'Date Closed');
    // Only a date counts: anything else next to "Date Closed" is another row's text, not a closing date.
    const closedRaw = tuClean(closed?.v);
    const closedOn = closedRaw && normalizeDate(closedRaw) ? closedRaw : null;
    const isCollection = /collection/i.test(`${type ?? ''} ${loan ?? ''} ${pay ?? ''}`) || !!original;
    const saysClosed = /\bclosed\b/i.test(`${pay ?? ''} ${remarks ?? ''}`);
    // The print has no status row. Closed comes from its closing date or its own wording; open is only said of an
    // account whose pay status was read and that nothing calls closed. Otherwise the status is left empty.
    const account_status = isCollection ? (closedOn ? `Collection, closed ${closedOn}` : 'Collection') : closedOn ? `Closed ${closedOn}` : saysClosed ? 'Closed' : pay ? 'Open' : null;
    if (account_status) m.account_status = tuMeta(closedOn && closed ? closed.line : tuField(info, 'Pay Status')?.line ?? head);

    // Remarks: what the bureau itself says about the account, in its words.
    const notes: string[] = [];
    const resp = text('Responsibility'); if (resp && !/^individual/i.test(resp)) notes.push(`Responsibility: ${resp}`);
    if (remarks) notes.push(remarks);
    const pastDue = text('Past Due'); if (pastDue && !/^\$?0(?:\.00)?$/.test(pastDue)) notes.push(`Past due: ${pastDue}`);
    const terms = text('Terms'); if (terms) notes.push(`Terms: ${terms}`);
    // The label is long enough to wrap, so the month is looked for on its line and the lines after it, up to the next row.
    const removalAt = info.findIndex((l) => l.startsWith('Estimated month and year'));
    let removal: string | undefined;
    for (let i = removalAt; removalAt >= 0 && i < Math.min(removalAt + 4, info.length) && !removal && (i === removalAt || !tuLabelOf(info[i]!)); i++) {
      removal = /\b((?:0[1-9]|1[0-2])\/\d{4})\b/.exec(info[i]!)?.[1];
    }
    if (removal) notes.push(`Estimated month and year this item will be removed: ${removal}`);
    if (notes.length) m.remarks = tuMeta(tuField(info, 'Remarks')?.line ?? notes[0]!);

    const payment_history = tuPaymentHistory(hist);
    if (payment_history) m.payment_history = tuMeta(payment_history);

    const t = finish({
      bureau: 'transunion',
      item_type: isCollection ? 'collection' : 'tradeline',
      creditor_name: name.slice(0, 200),
      original_creditor: original ? original.slice(0, 200) : null,
      account_last4: l4,
      account_type: type && loan ? `${type} (${loan})`.slice(0, 100) : (type ?? loan)?.slice(0, 100) ?? null,
      account_status,
      payment_status: pay ? pay.slice(0, 100) : null,
      balance_cents: money('Balance', 'balance_cents'),
      credit_limit_cents: money('Credit Limit', 'credit_limit_cents') ?? fromHistory('Credit Limit (Hist.)', 'credit_limit_cents', (a, row) => tuLatestAmount(row) ?? a[a.length - 1]!),
      high_balance_cents: money('High Balance', 'high_balance_cents') ?? fromHistory('High Balance (Hist.)', 'high_balance_cents', (a) => Math.max(...a)),
      date_opened: date('Date Opened', 'date_opened'),
      date_reported: date('Date Updated', 'date_reported'),
      date_of_first_delinquency: null,
      payment_history,
      remarks: notes.length ? notes.join(' · ').slice(0, 300) : null,
      field_meta: m,
    });
    out.tradelines.push(t);
    // Read with a name and nothing else, or with most of its rows empty: this file is not laid out the way the reader knows.
    const rows = info.filter((l) => tuLabelOf(l));
    const empty = info.filter((l, i) => { const k = tuLabelOf(l); return !!k && !l.slice(k.length).replace(/^:/, '').trim() && (i + 1 >= info.length || !!tuLabelOf(info[i + 1]!)); });
    const noDetails = t.balance_cents === null && !t.date_opened && !t.date_reported && !t.payment_status && !t.account_type;
    if (noDetails || (rows.length >= 3 && empty.length * 2 > rows.length)) unread++;
  });

  const inquiries = tuInquiries(lines);
  out.inquiries = inquiries.rows;

  // The reader checks itself. TransUnion prints no totals to compare with, so it looks for the ways a file laid out
  // differently would show: accounts that came out with few or no details, and an inquiry section with dates and no rows.
  if (unread) out.warnings.push(`${unread} ${unread === 1 ? 'account' : 'accounts'} on the TransUnion report ${unread === 1 ? 'was' : 'were'} read with few or no details. The file may be laid out differently from what the reader knows: compare every value with the original before approving.`);
  if (inquiries.dates > 0 && !inquiries.rows.length) out.warnings.push('The Regular Inquiries section of the TransUnion report shows dates, but no inquiry could be read from it. Add the hard inquiries from the original by hand.');

  // Public records are not read from this layout. When the section holds anything but a line saying there are none,
  // say so. ("Docket No. 26-10001" is a record: only a whole sentence about having none counts as none.)
  const recordsAt = lines.findIndex((l) => /^Public Records$/i.test(l));
  if (recordsAt >= 0) {
    const body: string[] = [];
    for (let i = recordsAt + 1; i < lines.length && body.length < 3 && !TU_SECTION.test(lines[i]!) && !/^Account Name\b/.test(lines[i]!); i++) body.push(lines[i]!);
    if (body.length && !TU_NO_RECORDS.test(body[0]!)) {
      out.warnings.push('This report has a Public Records section. Public records are not imported from this layout: add them from the original by hand.');
    }
  }
  return out;
}

/** The first line of a public records section that holds no record. */
const TU_NO_RECORDS = /^(?:none\.?|(?:you have |there are |we (?:have|found) )?no public records?\b.*|no (?:records?|items?) (?:were |was |are |is )?(?:found|reported|on file)\b.*)$/i;
