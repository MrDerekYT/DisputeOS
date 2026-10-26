import type { Bureau, Field, ParsedInquiry, ParsedReport, ParsedTradeline } from "./types";

const none = <T = string>(): Field<T> => ({ value: null, confidence: 0, source: null });

type Key = keyof ParsedTradeline;

// Exact label match is high confidence; alias match is lower.
const LABELS: Record<Key, { exact: string[]; alias: string[] }> = {
  creditor: { exact: ["account", "creditor"], alias: ["company", "furnisher", "subscriber"] },
  accountNumber: { exact: ["account number"], alias: ["acct #", "acct no", "account #"] },
  accountType: { exact: ["type", "account type"], alias: ["loan type"] },
  accountStatus: { exact: ["status", "account status"], alias: ["condition"] },
  paymentStatus: { exact: ["payment status"], alias: ["pay status", "rating"] },
  dateOpened: { exact: ["date opened"], alias: ["opened", "open date"] },
  dofd: { exact: ["date of first delinquency", "dofd"], alias: ["first delinquency"] },
  balance: { exact: ["balance"], alias: ["current balance"] },
  highCredit: { exact: ["high credit"], alias: ["high balance", "highest balance"] },
  creditLimit: { exact: ["credit limit"], alias: ["limit"] },
  originalCreditor: { exact: ["original creditor"], alias: ["orig creditor"] },
  paymentHistory: { exact: ["payment history"], alias: ["24 month history"] },
};

export function parseMoney(raw: string): number | null {
  const s = raw.trim();
  const m = s.replace(/[, ]/g, "").match(/^\(?-?\$?(-?\d+(?:\.\d+)?)\)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return /^\(|^-/.test(s) ? -n : n;
}

/** Accepts mm/dd/yyyy, mm/yyyy, yyyy-mm-dd, or "Jan 2019". Returns ISO date or null. */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[2]}-${m[1]!.padStart(2, "0")}-01`;
  m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{4})$/);
  if (m) {
    const i = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[1]!.toLowerCase());
    if (i >= 0) return `${m[2]}-${String(i + 1).padStart(2, "0")}-01`;
  }
  return null;
}

function detectBureau(text: string): Bureau | null {
  const head = text.slice(0, 600).toLowerCase();
  const hits = (["equifax", "experian", "transunion"] as const).filter((b) => head.includes(b));
  return hits.length === 1 ? hits[0]! : null;
}

function matchLabel(label: string): { key: Key; confidence: number } | null {
  const l = label.trim().toLowerCase();
  const entries = Object.entries(LABELS) as [Key, { exact: string[]; alias: string[] }][];
  for (const [key, def] of entries) if (def.exact.includes(l)) return { key, confidence: 0.95 };
  for (const [key, def] of entries) if (def.alias.includes(l)) return { key, confidence: 0.75 };
  return null;
}

function emptyTradeline(): ParsedTradeline {
  return {
    creditor: none(), accountNumber: none(), accountType: none(), accountStatus: none(), paymentStatus: none(),
    dateOpened: none(), dofd: none(), balance: none<number>(), highCredit: none<number>(),
    creditLimit: none<number>(), originalCreditor: none(), paymentHistory: none(),
  };
}

const MONEY: Key[] = ["balance", "highCredit", "creditLimit"];
const DATES: Key[] = ["dateOpened", "dofd"];

/**
 * Rules-based parser for "Label: value" style report text. The LLM extraction layer plugs in behind the same
 * output shape; anything this parser is unsure about gets a low confidence so the review screen surfaces it.
 */
export function parseReportText(text: string): ParsedReport {
  const warnings: string[] = [];
  const tradelines: ParsedTradeline[] = [];
  const inquiries: ParsedInquiry[] = [];
  let current: ParsedTradeline | null = null;
  let inInquiries = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^inquiries\b/i.test(line)) { inInquiries = true; current = null; continue; }
    if (/^(accounts?|tradelines?)\s*$/i.test(line)) { inInquiries = false; continue; }

    if (inInquiries) {
      const m = line.match(/^(.+?)\s*[-–|]\s*(\d{1,2}\/\d{1,2}\/\d{4})$/);
      inquiries.push({ name: m ? m[1]!.trim() : line, date: m ? parseDate(m[2]!) : null, source: line });
      continue;
    }

    const kv = line.match(/^([^:]{2,40}):\s*(.*)$/);
    if (!kv) continue;
    const hit = matchLabel(kv[1]!);
    if (!hit) continue;
    const value = kv[2]!.trim();

    // A creditor label starts a new tradeline block.
    if (hit.key === "creditor") {
      current = emptyTradeline();
      tradelines.push(current);
    }
    if (!current) { warnings.push(`Field before any account header ignored: "${line}"`); continue; }
    if (!value) continue;

    let parsed: string | number | null = value;
    if (MONEY.includes(hit.key)) parsed = parseMoney(value);
    else if (DATES.includes(hit.key)) parsed = parseDate(value);

    if (parsed === null) {
      warnings.push(`Could not interpret ${hit.key}: "${value}"`);
      if (current[hit.key].value === null) {
        (current[hit.key] as Field<string | number>) = { value: null, confidence: 0, source: line };
      }
    } else if (current[hit.key].value === null || hit.confidence > current[hit.key].confidence) {
      // Never let a weaker alias label overwrite a value already read from an exact label.
      (current[hit.key] as Field<string | number>) = { value: parsed, confidence: hit.confidence, source: line };
    }
  }

  if (!tradelines.length) warnings.push("No accounts found; this report may need OCR or the LLM extractor.");
  return { bureau: detectBureau(text), tradelines, inquiries, warnings };
}

export const last4Of = (n: string | null): string => (n ?? "").replace(/\D/g, "").slice(-4);

/** Fields with a value below this confidence, or an unreadable value, must be confirmed by a human. */
export const REVIEW_THRESHOLD = 0.8;

export function fieldsNeedingReview(t: ParsedTradeline): Key[] {
  return (Object.keys(t) as Key[]).filter((k) => {
    const f = t[k];
    return f.source !== null && (f.value === null || f.confidence < REVIEW_THRESHOLD);
  });
}
