/** An account number the comparison and the case tools recognise across reports: creditor and last digits (reports/service.ts matchKey). */
export const EXACT_KEY = "'^[^|]+[|][^|]+$'";

/**
 * The account's stored label (tradelines.kind_label, migration 0034) for a query on public.tradelines aliased `a`: its
 * own, or else a person's label on another report of the same account, marked as carried. The same account is the same
 * creditor and account number or, when the report prints no number (most Experian and TransUnion lines), the same
 * creditor and open date. Selected as `kind_label`; ./account-kind.ts decides what is shown.
 */
export const kindLabelSql = (a = 't') => `coalesce(${a}.kind_label, (select p.kind_label || '{"carried": true}'::jsonb from public.tradelines p
    where p.client_id = ${a}.client_id and p.org_id = ${a}.org_id and p.match_key = ${a}.match_key and p.id <> ${a}.id
      and (${a}.match_key ~ ${EXACT_KEY} or (${a}.date_opened is not null and p.date_opened = ${a}.date_opened))
      and p.kind_label ->> 'by' = 'staff' order by p.created_at desc limit 1)) as kind_label`;
