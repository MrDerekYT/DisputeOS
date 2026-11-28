/** An account number the comparison and the case tools recognise across reports: creditor and last digits (reports/service.ts matchKey). */
export const EXACT_KEY = "'^[^|]+[|][^|]+$'";

/**
 * The account's stored label (tradelines.kind_label, migration 0034) for a query on public.tradelines aliased `a`: its
 * own, or else a person's label on an earlier report of the same account (same creditor and account number), marked
 * as carried. Selected as `kind_label`; ./account-kind.ts decides what is shown.
 */
export const kindLabelSql = (a = 't') => `coalesce(${a}.kind_label, (select p.kind_label || '{"carried": true}'::jsonb from public.tradelines p
    where p.client_id = ${a}.client_id and p.match_key = ${a}.match_key and p.id <> ${a}.id and ${a}.match_key ~ ${EXACT_KEY}
      and p.kind_label ->> 'by' = 'staff' order by p.created_at desc limit 1)) as kind_label`;
