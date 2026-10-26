import type { Outcome } from "@/lib/responses";

// Heuristic, bilingual reading of a bureau reply. A human always confirms the result.
const NEGATED_DELETE = /\b(not|cannot|unable to|won't|will not)\b[^.]{0,30}\b(deleted|removed|remove|delete)\b|\bno\s+(se\s+)?(elimin|borr)/i;
const DELETED = /\b(deleted|removed|no longer (appear|report)|has been removed)\b|\belimin(ad|ó|amos)|\bborrad/i;
const VERIFIED = /\b(verified|confirmed|accurate|will remain|remains?)\b|\bverificad|\bse mantiene|\bcorrect[oa]\b/i;
const UPDATED = /\b(updated|modified|corrected|changed|revised)\b|\bactualiz|\bmodific|\bcorreg/i;

export function classifyReply(text: string): Outcome | null {
  const t = text.trim();
  if (t.length < 8) return null;
  if (NEGATED_DELETE.test(t)) return "verified";
  if (DELETED.test(t)) return "deleted";
  if (UPDATED.test(t)) return "updated";
  if (VERIFIED.test(t)) return "verified";
  return null;
}
