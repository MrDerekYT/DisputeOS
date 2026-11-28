-- 0034 What each account on a credit report is: a person's label, or an AI suggestion.
-- Additive and safe to run again: one nullable column on public.tradelines. No existing row changes, the existing
-- row-level security policies of the table cover it, and nothing here needs a superuser.
--
-- Most accounts need nothing stored: the label is read from the report's own words every time a page opens
-- (src/lib/credit/account-kind.ts), so it stays right after a correction. This column holds only what the words cannot
-- give:
--   {"kind": "collection", "by": "staff", "at": "…", "user": "…"}                    a person chose the label
--   {"kind": "collection", "by": "ai", "words": "…", "field": "account_status", …}   an AI suggestion, kept only when its
--                                                                                     words are in that account
--   {"kind": "unknown", "by": "ai", "at": "…"}                                       AI was asked and could not tell
-- A person's label is carried to the same account (same creditor and account number) on a later report of the client.
alter table public.tradelines add column if not exists kind_label jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tradelines_kind_label_check') then
    alter table public.tradelines add constraint tradelines_kind_label_check check (
      kind_label is null or (
        jsonb_typeof(kind_label) = 'object'
        and kind_label ->> 'by' in ('staff', 'ai')
        and kind_label ->> 'kind' in ('collection', 'charge_off', 'foreclosure', 'repossession', 'bankruptcy', 'settled', 'late', 'was_late', 'negative', 'good', 'no_negative', 'unknown')
        and char_length(coalesce(kind_label ->> 'words', '')) <= 200
      ));
  end if;
end $$;
