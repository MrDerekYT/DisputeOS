-- System templates (org_id null). Fictional/neutral sample; no outcome promises.
insert into public.templates (org_id, name, category, body, merge_fields)
select null, 'FCRA §611 reinvestigation request', 'bureau_611',
$t$Dear {{bureau}},

I am writing under 15 U.S.C. § 1681i to dispute the accuracy of the following item on my credit file: {{creditor}} {{account}}.

{{reason}}

Please reinvestigate and send me the results in writing.

Sincerely,
{{clientName}}$t$,
ARRAY['bureau','creditor','account','reason','clientName']
where not exists (select 1 from public.templates where org_id is null and name = 'FCRA §611 reinvestigation request');
