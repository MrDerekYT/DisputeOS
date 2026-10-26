const PATTERNS: [RegExp, string][] = [
  [/\b\d{3}-?\d{2}-?\d{4}\b/g, "[SSN]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[ACCOUNT]"],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[EMAIL]"],
  [/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, "[DATE]"],
];

/** Remove common PII shapes from strings before they reach logs, Sentry, or LLM prompts. */
export function scrubPii(input: string): string {
  return PATTERNS.reduce((s, [re, rep]) => s.replace(re, rep), input);
}

export function scrubDeep<T>(value: T): T {
  if (typeof value === "string") return scrubPii(value) as T;
  if (Array.isArray(value)) return value.map(scrubDeep) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v)])) as T;
  return value;
}
