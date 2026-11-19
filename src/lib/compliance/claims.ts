/**
 * Blocked-claims guard. Credit repair marketing and correspondence is regulated (CROA, FTC Act, FCRA, state laws).
 * This is a safety net, not a legal filter: it blocks the most common prohibited promises in text the system
 * generates (AI output, automation messages, templates) and WARNS on text a person writes themselves.
 */
interface Rule {
  id: string;
  pattern: RegExp;
  why: string;
}

const RULES: Rule[] = [
  { id: 'guarantee', pattern: /\bguarantee[sd]?\b|\bguaranteed\b/i, why: 'Results cannot be guaranteed.' },
  { id: 'certain-removal', pattern: /\b(will|we will|we['’]ll|are going to|going to)\s+(be\s+)?(delete[d]?|remov(e|ed)|eras(e|ed)|wip(e|ed))\b/i, why: 'Do not promise that an item will be removed.' },
  { id: 'remove-all', pattern: /\b(remove|delete|erase|wipe)\s+(all|every|any)\s+(of\s+)?(your\s+)?(negative|bad|derogatory)/i, why: 'Do not promise to remove all negative items.' },
  { id: 'score-promise', pattern: /\b(raise|boost|increase|improve|jump|add)\b[^.]{0,40}\b(score|fico)\b[^.]{0,30}\b(by|to)\s+\d+|\b\d+\s*(\+\s*)?points?\b[^.]{0,20}\b(guaranteed|in\s+\d+\s+(days|weeks))/i, why: 'Do not promise or quantify a score increase.' },
  { id: 'fixed-time', pattern: /\b(fix|repair|clean)\b[^.]{0,30}\bcredit\b[^.]{0,20}\bin\s+\d+\s+(days?|weeks?)\b/i, why: 'Do not promise results within a time frame.' },
  { id: '100pct', pattern: /\b100\s*%\s*(success|guarantee|effective|removal|deletion)/i, why: 'No success-rate promises.' },
  { id: 'new-identity', pattern: /\bCPN\b|credit privacy number|new credit identity|file segregation/i, why: 'Creating a new credit identity is illegal.' },
  { id: 'accurate-removal', pattern: /\b(accurate|correct|valid|legitimate)\b[^.]{0,40}\b(can|will|could)\s+be\s+(removed|deleted)/i, why: 'Accurate, verifiable information cannot be removed on demand.' },
  { id: 'accurate-removal-2', pattern: /\b(can|could|will|able to|going to)\s+(remove|delete|erase)\b[^.]{0,40}\b(accurate|correct|valid|legitimate|truthful|true)\b/i, why: 'Accurate, verifiable information cannot be removed on demand.' },
  { id: 'legal-guarantee', pattern: /\b(legally|by law)\s+(required|obligated|forced)\s+to\s+(delete|remove)/i, why: 'Do not misstate legal obligations.' },
];

export interface ClaimIssue {
  id: string;
  why: string;
  excerpt: string;
}

export function findBlockedClaims(text: string): ClaimIssue[] {
  const issues: ClaimIssue[] = [];
  for (const r of RULES) {
    const m = r.pattern.exec(text);
    if (m) issues.push({ id: r.id, why: r.why, excerpt: m[0].slice(0, 80) });
  }
  return issues;
}

export class BlockedClaimError extends Error {
  constructor(public issues: ClaimIssue[]) {
    super(`Text contains prohibited claims: ${issues.map((i) => `“${i.excerpt}” (${i.why})`).join('; ')}`);
  }
}

/** Throws for system-generated text. */
export function assertNoBlockedClaims(text: string): string {
  const issues = findBlockedClaims(text);
  if (issues.length) throw new BlockedClaimError(issues);
  return text;
}
