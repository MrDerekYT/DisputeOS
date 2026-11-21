# Integrations — what is real and what is not

Settings → Integrations shows this live, derived from configuration. **"Verified" means exercised against the real
third-party service from this codebase. None of the paid third-party integrations below have been.**

| Integration | Status | Notes |
|---|---|---|
| PostgreSQL | **Active, verified** | Tested against PostgreSQL 16. Works on any managed Postgres that lets you create the `disputeos_rls` role (see ENVIRONMENTS.md). |
| Document storage | **Active, verified** | Encrypted files on a server volume (`STORAGE_DRIVER=disk`, `STORAGE_DIR`) or, for hosts with no persistent disk such as Vercel, encrypted rows in the database (`STORAGE_DRIVER=db`, table `stored_objects`). Both verified by tests. **S3-compatible storage is not built.** |
| Email — Resend | Implemented, **not verified live** | `EMAIL_DRIVER=resend` + `RESEND_API_KEY` + verified domain. The default `log` driver writes to `.storage/outbox/` and delivers nothing; the UI marks such messages "Not delivered". It is for development and test only: staging/production refuse to start unless `EMAIL_DRIVER=resend`. |
| Email — none (`EMAIL_DRIVER=disabled`) | **Manual**, verified by tests | The explicit way to run staging/production without an email provider. Nothing is sent or logged; invitations show a one-time link to pass on; client emails are recorded as not delivered; lead follow-up stays off; **password reset by email is unavailable** and the reset page says so. |
| AI — Anthropic (Claude) / OpenAI-compatible | Built to the current Anthropic API with the official SDK, **verified against a mocked API only**; proven live only once `npm run ai:prove` has passed with a real key | `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` (model via `AI_MODEL`, default `claude-opus-5-5`; `AI_EFFORT` low/medium/high, default low), or `AI_PROVIDER=openai` + `AI_BASE_URL` + `AI_API_KEY` + `AI_MODEL`. The deterministic engine is complete without them. See [AI provider (Claude)](#ai-provider-claude). |
| AI credits (metering) | **Works, tested; buying online is not connected** | Every AI result that is returned costs credits from the workspace's balance (`src/lib/ai/credits.ts` holds the price list; ledger in `ai_credit_ledger`, migration 0012). A workspace with no credits, or with no AI provider, gets the standard non-AI wording. There is no checkout: the platform operator adds credits with `npm run credits:grant -- <org-slug> <amount> [note]`. Selling credits in the app needs a payment processor (e.g. Stripe), a checkout and a webhook that writes `purchase` rows. |
| Text messages — Twilio | Implemented, **verified against a mocked API only**; off by default (`SMS_DRIVER=disabled`) | Short “there is an update, sign in to see it” texts to clients who agreed to them, for the events an agency switches on under Settings → Client updates. Needs `SMS_DRIVER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_FROM_NUMBER`, plus the provider-side registration. See “Client updates by text message and email” below. The same driver sends the two follow-up texts to leads who ticked the text-message box on the enquiry form (“Referral partners and lead text follow-up”). Until the Twilio variables are set, Settings shows “Not connected” and staff log calls and texts by hand. Every text goes to a US number only, and none leaves for a workspace the platform operator has not approved (`npm run outreach:approve`); Settings says so when that is what holds texts back. |
| Payment processing (Stripe etc.) | **Manual** (no processor integration) | Payments are recorded manually; there are no Stripe settings. Also constrained by the CROA advance-fee rule. |
| Credit Connect (consent-gated import pipeline) | **Pipeline works, tested; no live provider** | Upload, inbound REST API, and an adapter framework with a dev-only sandbox. Nothing is imported automatically from a real provider, so Settings shows "Test stand-in only" in development and "Manual path in use" in staging/production. See `docs/CREDIT_CONNECT.md` |
| Public REST API + API keys | **Works, tested** | `/api/v1/*`, OpenAPI at `/api/v1/openapi.json` |
| Live provider adapters (Array, IDIQ, bureaus) | **Manual** (no adapter; needs partner approval) | Provider APIs are partner-gated and require a permissible purpose and client authorization; there is no legitimate unauthenticated access. Import by upload/CSV today. |
| Electronic signatures (external provider) | **Manual** (no provider integration) | Typed-name e-signature in the portal is provided: each signature stores the exact text shown, its SHA-256, the page language, the time and the IP address, and a PDF copy can be downloaded (`/api/consents/<id>/pdf`). |
| Certified mail (Lob, etc.) | **Manual** (no provider integration) | The approved PDF is produced; a person mails it and records tracking. |
| Custom domains for agency websites | **Automatic** with `VERCEL_API_TOKEN` + `VERCEL_PROJECT_ID` (`VERCEL_TEAM_ID` for a team project); otherwise **manual** | An agency connects a domain it already owns on its Website page; its `/a/<workspace-slug>` address keeps working. With the Vercel variables set, the app adds the domain to the project, shows the DNS records and marks it connected only when Vercel reports it verified and correctly configured and the workspace's own TXT record (`_disputeos.<domain>`) is in the domain's DNS: that record is what shows the workspace controls the domain. Without the variables the domain stays "not connected yet" until the platform operator adds it in Vercel and runs `npm run domain:verify -- <domain>`, which checks the same TXT record and needs `PII_ENCRYPTION_KEY` in its environment. Buying a domain is not built in. Steps: docs/DEPLOY-VERCEL.md. Tested against a mocked API only. |
| Specialty reporting agencies (ChexSystems, Early Warning, LexisNexis, Innovis, NCTUE, TeleCheck, Clarity) | **Manual** (no data feed, no integration) | Disputes with these agencies go through the normal pipeline, but nothing is connected to them. See "Specialty reporting agencies" below. |
| External CRM sync | **Manual** (no sync integration) | Per-client JSON export exists. |
| Error monitoring (Sentry) | **Not wired** | A PII scrubber is ready (`src/lib/scrub.ts`). |

## Specialty reporting agencies (manual entry, not an integration)

The app can prepare disputes with seven specialty consumer reporting agencies as well as the three credit bureaus:
ChexSystems, Early Warning Services, LexisNexis Risk Solutions, Innovis, NCTUE, TeleCheck and Clarity Services. **None of
them is connected.** There is no data feed from any of these agencies, no account with them, and no way to request,
download or submit anything on a consumer's behalf. The consumer requests their own free disclosure from the agency (the
client record links to each agency's own page); staff record whether it was requested or received and may store the file.
These reports are **never parsed**: the formats differ, so a person types in the item to dispute exactly as it appears on
the disclosure, and the reason. The letter repeats only that text, is approved by a person, and is mailed by a person.

Each agency's details live in one file, `src/lib/credit/agencies.ts`. A dispute mailing address is stored there only
when it was read on the agency's own website, with the page and the date beside it (all read on 2026-11-19). Verified:
ChexSystems, Early Warning, LexisNexis and NCTUE. Not verified, so none is stored and staff must type the address from
the agency's current instructions: Innovis and TeleCheck (their dispute pages point to a mail-in form without printing
the address) and Clarity Services (its site gives a consumer support address but does not say disputes go there).
Agencies change addresses; re-check the source page before relying on a date that is old. The 30-day window shown is
the general Fair Credit Reporting Act reinvestigation period, not a figure specific to any agency, and state law can
shorten it. Not included: SageStream and CoreLogic Credco, which were not clearly sourced.

## Credit-monitoring referral link (not an integration)

Settings → Organization lets an agency set one optional https link to a paid monitoring service (for example an affiliate
link) plus a display name. It is **only a link**: no data flows to or from that service, nothing is imported through it, and
reports still arrive by upload (or the REST API) exactly as before. Clients see it in the portal under Documents, below the
free AnnualCreditReport.com instructions, marked optional; unless the agency unticks "I may earn a commission from this
link", the client is told the agency may earn a commission. Stored in `organizations.settings` (`monitoring_url`,
`monitoring_label`, `monitoring_paid`) and re-validated on every read (`src/lib/monitoring.ts`).

## What each status means

Settings → Integrations labels every integration by what happens **in the configured environment**:

| Label | Meaning |
|---|---|
| Active | Connected and in use |
| Test stand-in only | A development substitute is in use (a log file, synthetic data). Nothing real happens |
| Needs credentials | Built and switched on, but missing the credentials it needs |
| Manual path in use | No provider is connected. A person completes the step through the documented manual path |
| Not built | No integration and no manual path (no row uses this today) |

## Pilot workflow: the manual path and the exact remaining dependency

| Step | Status today | Supported manual path | Exact remaining dependency |
|---|---|---|---|
| Live credit pulls | Development/test: sandbox with SYNTHETIC data only. Staging/production: manual | Upload the report (PDF, HTML, text, CSV template) or push it through `POST /api/v1/clients/{id}/reports`. Needs the client's FCRA authorization; a person approves every report | Signed partner/reseller agreement and issued API credentials from a report provider; then one adapter file (docs/CREDIT_CONNECT.md) |
| Certified mail | Manual | Download the approved PDF, mail it, record method + date sent + optional tracking. Stored as `delivery_source = staff_recorded` and shown as "Recorded by staff" | A print-and-mail account (e.g. Lob), API key, sender address, and an integration that sends approved letters and reads delivery events. Only that integration may set `carrier_confirmed` |
| Payments | Manual | Record payments collected elsewhere on the client's Billing tab (requires the CROA "service already performed" confirmation) | Stripe (or similar) account, API keys, webhook secret, Checkout + webhook integration |
| SMS | Manual until Twilio is connected (the default) | Text/call from your own phone and log it on the client's Messages tab ("nothing is sent") | A Twilio account with a sending number registered for US messaging and the four variables in “Client updates by text message and email”; the operator's approval of the workspace (`npm run outreach:approve`); each client's own agreement to texts, for a US number. Two-way texting from the Messages tab is not built: the integration only sends the automatic client updates and the consented lead follow-up texts, and records replies |
| External e-signature | Manual | Typed-name signature in the portal's welcome steps (name, time, IP, the exact text shown and its SHA-256, a PDF copy), or staff record a paper signature (the date written on the paper, the staff member who recorded it, and the app's text on the recording day, which is not a copy of the paper, are stored) | Only if counsel requires a third-party signing service: an account with it and the integration |

## Leads follow-up and the credit guide: what they need

| Feature | Works with nothing connected | Needs | What is not there |
| --- | --- | --- | --- |
| Leads page, enquiry form, tagged links, counts | Yes | Nothing | — |
| Automatic follow-up email to leads | **No.** With the `log` driver nothing is sent and nothing is recorded as sent; the Leads page says why (not approved yet, or "Email is not connected") | `EMAIL_DRIVER=resend` + `RESEND_API_KEY` + a verified sending domain for `EMAIL_FROM`; the platform operator's approval of the workspace (`npm run outreach:approve`); the agency's postal address and reply address saved on the Leads page; the switch on. The welcome is sent right after the enquiry; the follow-up and last note need the scheduled job below to be running | **Replies are not read.** They go to the agency's reply address; staff press "They replied" or "Asked to stop". Reading them needs an inbound-email webhook, which does not exist. The From line is `"<Agency name>" <address from EMAIL_FROM>`; the Resend driver, including this, is not verified against the live service. A step whose result was never recorded stays "not confirmed" and is not re-sent |
| Text follow-up to leads | **No.** Off by default, and nothing is texted or offered on the form until a text service is connected and the workspace is approved | The platform operator's approval of the workspace (`npm run outreach:approve`), the lead follow-up switch on, the text switch on (Leads page), `SMS_DRIVER=twilio` with its credentials, and **the lead's own tick** in the separate text-message box on the enquiry form. See “Referral partners and lead text follow-up” | No tick, no text: that lead gets email only. Two texts at most (welcome, follow-up after 3 days). Not verified against live Twilio |
| Referral partner email sequence | **No.** Off by default; with the `log` driver nothing is sent and nothing is recorded as sent | The platform operator's approval of the workspace (`npm run outreach:approve`), the switch on (Partners page), the same postal and reply addresses as the lead follow-up, `EMAIL_DRIVER=resend`, and the scheduled job running on business days | **Email only: partners are never texted or called.** Replies are not read: staff press “They replied”, “Interested” or “Not interested”. Bounces and spam complaints are read only when the Resend webhook is set up; without it staff press “Bounced”. No scraping, bought lists or directory import: the agency adds partners itself. Not verified against live Resend |
| Credit guide (chat box) | Yes — answers come from the vetted knowledge base by keyword match | Nothing. Optional: `AI_PROVIDER` (same settings as the AI row above) lets a model re-phrase the retrieved entries | With AI on, the question is sent to the provider with the client's own details on file (address, city, ZIP code, SSN last four, date of birth), the names the app knows, contact details, Social Security, card and account numbers, dates, street addresses with a common street type, city-state-ZIP lines and amounts masked by matching; anything else in it is sent as written. Output is discarded and the vetted text shown when a pattern rule matches a promise or a prediction of a result, an unknown number or web address, or a prompt marker; the rules are patterns, not a proof. Tested against a stand-in provider; live only through `npm run ai:prove` |

## Referral partners and lead text follow-up

Code: `src/lib/partner-emails.ts` (wording, timing), `src/lib/partner-import.ts` (reading a list),
`src/lib/partner-outreach.ts` (sending, opt-out, bounces), `src/lib/outreach-approval.ts` (the operator's approval),
`src/lib/partners.ts` (what staff record), `src/lib/lead-texts.ts`, `src/lib/lead-outreach.ts` and `src/lib/us-phone.ts`
(lead texts), the pages under `/app/partners`, `/unsubscribe/partner/<token>`, `/api/unsubscribe/partner/<token>` and
`/api/webhooks/resend`, migrations `0028_partner_outreach.sql` and `0030_partner_opt_outs.sql`.

**Who is on the list.** Businesses that can refer clients (real estate agents, loan officers, mortgage brokers, car
dealerships, tax preparers, property managers), added by the agency itself: one at a time, or as a list pasted or
uploaded as CSV (a header line with an `email` column; up to 200 rows per import; invalid rows are left out and named;
an address repeated in the list or already on file is skipped). One mailbox is one partner: the unique key of a partner
within an agency reads the address as the opt-out list does (lower case, without a "+tag", and for Gmail without dots),
so `dana+1@` next to `dana@` is skipped as already listed and nobody gets the sequence once per spelling. A city is
printed in the introduction, so it has to be a plain place name, and one whose name reads as a claim to the claims guard
("Free Soil") is refused with a message that says to leave the city out. The person adding partners confirms the
contacts came from public business contact details or the agency's own contacts: who confirmed it and when is stored on
every row, and the sentence they ticked is kept on the audit entry of the addition.
Nothing is scraped, bought, looked up or imported from a directory.

**What is sent.** Three plain-text emails per partner: an introduction, a follow-up 4 business days later and a last
note 9 business days after the introduction, in English or Spanish, with wording per category. They say what the agency
does (helps consumers review their credit reports and dispute inaccurate information), say plainly that no result, score
or loan approval can be promised, greet the contact by first name, state nothing about the partner beyond the category
and city on the record, and link to the agency's published website when there is one (the introduction and the
follow-up do). Every email says it is a business solicitation from the agency, shows the agency's name and postal
address, and carries an opt-out link (it opens a page with one button) and one-click unsubscribe headers (CAN-SPAM,
15 U.S.C. § 7704). Subject lines name the agency and say what the email is. All of it passes the marketing claims guard.

**What has to be true before anything goes out.** The platform operator has approved the workspace for outreach (see
"Operator approval" below); an owner or admin switched the sequence on (Partners page; off by default); the mailing
address and reply address are saved (the same two the lead follow-up uses; see "The mailing address" below); email is
really connected; and the emails as they would leave pass the claims guard with the agency's own details in them: its
name (which also may not carry a web address or run past 80 characters: it is in every subject and From line), the
address of its published website, and its mailing address. When one of these is in the way the Partners page says which
one and why, and nothing is claimed or sent. Then the scheduled job sends with **no approval of each message**: on
business days in the workspace's time zone, at most 10 per run and 40 per agency in any 24 hours (10 during the first 14
days after approval), and at most `OUTREACH_PLATFORM_DAILY_EMAILS` (default 500) across every workspace of the
deployment. Each (partner, step) is handed to the email service once; only a step the service refused can be tried
again, and only when a person asks.
A step is claimed through a unique key before the email is handed over, under one lock for the deployment that makes
all of these limits exact when runs overlap. With the two runs a day scheduled in `vercel.json` that is at most 20
emails a day per agency (one run is in the early morning, US time); schedule more runs during the day to reach the limit.

**The wording is fixed.** No model writes any part of a partner email. An earlier option to let an AI provider reword
the connecting sentences was removed: its only safeguard on free text was a list of phrases, which can always be worded
around, and nobody read the result before it was sent. The setting `partner_outreach_ai` is no longer read and is
deleted when the Partners form is saved. The code that was written for the rewording, and its tests, have been removed.

**The mailing address.** It is printed under every partner email (and under the lead follow-up emails, which read the
same setting). It is the one line of those emails an agency types freely, and the operator's approval does not cover
it. So it is held to the shape of a US postal address (`src/lib/mailing-address.ts`): 12 to 160 characters on one
line, only letters, digits and the punctuation addresses use; starting with a street number or a box (PO Box, PMB,
rural route, suite or unit, and the forms Puerto Rico uses) and ending with the state (code or name) and the ZIP code;
no web address, no phone number, nothing the claims check refuses, and only a few words between commas (house
numbers and standard address words such as "St", "Blvd" or "Suite" are not counted). The Partners form and the Leads
form refuse anything else with a sentence that says what to enter. A value saved before this rule that does not pass
it reads as "no address": the Leads and Partners pages show it with what is wrong, and nothing that prints it is sent
until it is corrected. The rule keeps most messages out of the field; it cannot tell whether an address is real, and a
short phrase can still have the shape of an address part.

**Operator approval.** Sign-up is open and unverified, and every workspace sends through the deployment's one email
service and one text number. So nothing unattended to a person who is not yet a client (lead follow-up emails and texts,
partner emails), and no text of any kind (client updates by text, the test text on the Get set up page), goes out for a
workspace until a person at the operator has looked at it and run

    npm run outreach:approve -- <org-slug>          # approve under the business name it has now
    npm run outreach:approve -- <org-slug> --revoke # withdraw

The approval is two columns on `organizations` (`outreach_approved_at`, `outreach_approved_name`; migration 0028) that
no tenant request can write. It is for the business name the workspace had at that moment: after a rename nothing is
sent until it is approved again. What to look at before approving: is it a real credit repair business, is the name its
own (the code refuses a name with a link in it; it cannot tell that "Wells Fargo Home Mortgage" is not theirs), and
where does its partner list come from. The Partners and Leads pages tell the agency plainly when it is waiting for this.
The lead follow-up emails need the approval for the same reason as the rest: the enquiry form is public and takes any
address, and the business name is the From name and part of the subject of every such email, so without the gate a
workspace nobody has looked at could put a name of its choice in a stranger's inbox. The approval, the switch and both
addresses are read again with every email that is claimed. Until a workspace is approved, the emails its staff send by hand to a client or lead ("Email welcome link", an email from the Messages tab, "New client" with the invitation ticked) are limited to 50 an hour for the whole workspace. What does not need the approval: emails to the workspace's
own team and clients (invitations, sign-in emails, client updates by email).
Before it records an approval the command prints the mailing address and the reply address the workspace has saved:
besides the name they are what its automatic emails carry, and the workspace can change both later without a new approval.

**When it stops.** An opt-out (at once, and for good: the database refuses to undo it, to change the address, or to add
that address to the agency's list again); staff recording a reply, "interested", "not interested" or a bounce; a manual
pause; and an email that does not go through, of which there are three kinds.

- *The email service refuses it.* That partner stops until someone presses "Try again", three attempts at most. Two
  refusals in a row mean the sending side is probably broken, so the whole sequence then holds for 24 hours, or until
  someone presses "Try again" on one of them, and the owners and admins get an in-app notification with the reason: a
  domain that is not verified stops two partners, not the list. A request that never reached the service because no
  connection could be made (the name did not resolve, the connection was refused) counts as a refusal: nothing can
  have been sent.
- *The email service does not answer* (a timeout, a connection that drops). The email may or may not have gone out, so
  the step stays "not confirmed": it is never sent again, nobody is offered "Try again", it does not count towards the
  hold, and the run hands nothing more to the service. The partner's page shows the email and says to contact the
  partner yourself. A send whose result was never recorded (a crash) is treated the same way.
- *The app's own claims guard refuses it*, because something on that partner's record reads as a claim (a city or a
  first name; what is the same in every email was checked before the run). That partner stops and its page says why.
  It is not a refusal by the email service: no hold and no notification follow.

**How a partner opts out.** The link in every email opens a page that asks "Stop emails from <agency>?" with one
button; pressing it is the opt-out, with no sign-in. Opening the page changes nothing, because mail security gateways
fetch the links in incoming mail: if a fetch were the opt-out, the first email would opt out every partner behind such
a gateway for good. Every email also carries `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
(RFC 8058), pointing at `POST /api/unsubscribe/partner/<token>`, so the "unsubscribe" button of a mail program does the
same. An opt-out the recipient made (the link, the mail program's button, a spam complaint) goes on one list for the
whole deployment, `public.partner_opt_outs` (migration 0030), keyed by the address as the opt-out list reads it (lower
case, without a "+tag", and for Gmail without dots): an address that stopped these emails is not written to through
another workspace or as `dana+1@` either. The list belongs to no workspace and no user, so it survives deleting
either, and no signed-in person can read or change it. In the other workspace that partner is paused, with the reason
on its timeline; it is not stamped as opted out there, because that stamp can never be lifted. "Asked to stop"
pressed by staff is different: it stops that workspace's own emails to the address for good and no other workspace's,
so one workspace cannot switch off another's partner emails by listing its addresses. The recipient's own opt-out
counts even when staff had pressed "Asked to stop" first, and the page behind the link still offers its button then.
Staff can still record that an opted-out partner replied or is interested (they may telephone); that sends nothing and
does not lift the stop. Where a partner stands in the sequence (new, in sequence, finished) is written by the scheduled
job only: a signed-in person cannot put an address that bounced, or one whose sequence is over, back in line.

**Bounces and complaints.** A reply goes to the agency's reply address; this app does not read that mailbox, so staff
record replies on the partner's page. Bounces and spam complaints can be reported by the email service: add a webhook
in Resend for `email.bounced` and `email.complained` pointing at `POST /api/webhooks/resend`, and put its signing
secret in `RESEND_WEBHOOK_SECRET` (the route answers 404 until then, and trusts a request only when its Svix signature
verifies; `src/lib/resend-webhook.ts`). A bounce stops that partner; a complaint opts the address out for good. The
same webhook covers the automatic follow-up emails to leads: a bounce or a complaint about one ends all automatic
follow-up to that lead (emails and texts), and the lead's timeline and the Leads page say which it was. With
three or more bounces since the workspace was approved, and more than one in ten of what was sent, the whole sequence
holds until the list is cleaned and the operator approves the workspace again. Both numbers are counted from the
approval date with no time limit, so the hold does not end by itself after a month. Without the webhook, staff press
"Bounced" themselves, and the same hold applies. **Not verified:** the webhook is written to Resend's and Svix's
published documentation and tested against signatures computed the same way; it has not received a live event.

**A separate sending address (recommended).** Set `OUTREACH_EMAIL_FROM` (an address on its own subdomain, for example
`partners@outreach.yourdomain.com`) and `OUTREACH_RESEND_API_KEY`, and partner emails leave through them instead of
`EMAIL_FROM` and `RESEND_API_KEY`, so unsolicited business email cannot hurt the reputation of the address that
carries password resets, invitations and client updates. Unset, they share the main address.

**Referred by.** A client can be linked to the partner who sent them (client page → Referred by); each partner shows
how many clients are linked.

**Text follow-up to leads.** Off by default, with its own switch on the Leads page, and effective only once the
operator has approved the workspace (above). When it is on and a text service is connected, the public enquiry forms
(`/start/<slug>` and the agency website) show a second box for text messages: unticked, optional and worded on its own.
Ticking it stores a consent in `sms_consents` with source `enquiry_form`: the exact wording shown, the number, the
time, the IP address and the browser. Only such a lead is texted: a welcome text and one follow-up three days later, to
that number, naming the agency and ending with STOP and HELP. No tick means email only, and a consent recorded by staff
or given in the portal (for file updates) never unlocks these texts.

What keeps the public form from being a way to text anyone:

- **US numbers only.** The number has to be a "+1" number whose area code belongs to a state, DC or Puerto Rico
  (`src/lib/us-phone.ts`). Another country, Canada, the Caribbean, toll-free, 900 and 976 numbers are refused with a
  message that asks for a US mobile number, and so is a number that cannot exist (an exchange that starts with 0 or 1,
  or a service code such as 911), typed with or without its "+". The area-code list is an allowlist written from the
  numbering plan as known in 2026; **it was not checked against NANPA's published list from the build environment**,
  so compare it with nationalnanpa.com before relying on it. A code missing from it only means that number gets no
  text. Guam, the Northern Marianas, American Samoa and the US Virgin Islands are not texted.
- **The person's own hours.** These are marketing texts, so they go out between 9:00 and 20:00 only, judged in the
  workspace's zone, in Eastern and Pacific, and in the zones of the state the number's area code belongs to. A text
  held for the night goes out with the 20:00 UTC run, which is inside that window in every US time zone.
- **Limits.** One text consent per number per agency, also when the form is sent several times at the same moment (the
  check runs under a lock on the agency and the number); at most 40 lead texts per agency and
  `OUTREACH_PLATFORM_DAILY_TEXTS` (default 300) for the deployment in any 24 hours, counted under a lock when a text is
  claimed. A text counts from the moment it is claimed, whatever becomes of it: one the text service refused, or the
  carrier later reported undelivered, still counts. Texts to a lead that has since been deleted are no longer counted.
- **The business name.** It starts every text, so a name that carries a web address sends nothing.
- **Stopping.** STOP withdraws the consent for good. "Asked to stop" on a lead does the same (and ends the emails), so
  the consent cannot carry over if the lead becomes a client. Neither the public form nor staff can switch texts back
  on for such a number; only the person can, signed in to the portal. A consent staff switched off is not brought back
  by the form either.
- **Replies and delivery reports.** A reply goes to the record of the workspace that texted the number last, counts as
  "replied" and ends the automatic follow-up there. When that cannot be told (the same person agreed to texts from two
  workspaces and neither was texted more recently), each record is told that a reply arrived and texts to it pause, but
  the wording is shown to neither; the message itself is kept with no workspace and counted in the job's result. Every
  record that carries the number is looked at, however many there are, so another workspace cannot push the lead who was
  texted out of the match, or keep a STOP from reaching their consent, by typing the number onto records of its own. A
  carrier failure report marks the step failed, so no second text goes to a number that does not take them.

Have your attorney review the consent wording, and note that a carrier registration made for account notifications
(A2P 10DLC) does not cover marketing follow-up: the campaign has to describe this use.

**Not verified.** No partner email has gone through the live Resend service and no lead text through live Twilio from
this codebase. They are tested against stand-ins, and once through the real drivers with the providers' HTTP mocked.

## Client updates by text message and email

Short messages that tell a client there is something new in their portal. Code: `src/lib/sms.ts` (driver),
`src/lib/client-updates/` (wording, rules, sending), `src/app/api/webhooks/twilio/route.ts` (replies and delivery
reports), migration `0018_client_updates.sql`.

**What is sent.** Six events, each with a text and an email in English and Spanish: dispute sent; response recorded;
document needed; document rejected; investigation window passed with no response; new message from the team. A text
never says anything about the file (no account, company, amount or outcome): it names the agency, says there is an
update, gives the portal sign-in link and ends with “Reply STOP to stop, HELP for help”. An email may name the stage,
still with no account detail. Every generated message passes the claims guard before it is sent; a business name that
itself makes a promise blocks the send and the failure is recorded.

**What has to be true before anything goes out.**

1. The channel is connected (below). Otherwise the switches on Settings → Client updates are disabled, with the reason.
2. An owner or admin switched that event on for that channel. Everything is off by default.
3. The client has a portal sign-in (every message says “sign in”), and for email an address on file.
4. For a text: the client's SMS consent is in force **for the number on their record**. No consent, no text, ever.
5. For a text: **the platform operator has approved the workspace** under the name it has now (“Operator approval”
   above; `npm run outreach:approve -- <org-slug>`). Sign-up is open and every text leaves through the deployment's one
   number, so a workspace nobody has looked at texts no one, whatever it switched on and whatever consents it recorded.
   The approval is read from the database when a text is queued and again when it is about to leave, and the text
   carries the name that was approved; after a rename nothing is texted until the operator approves again. Emails of
   client updates do not need the approval.
6. For a text: **the number is a US one** (the rule lead texts are held to, `src/lib/us-phone.ts`). A consent cannot be
   recorded for any other number, in the portal or by staff; a consent already on file for one sends nothing; and the
   sender itself (`sendSms`) hands no other number to the provider.

Where a text service is connected and the approval is missing, the consent block on each client's page and the
test-text step of the Get set up page say so, and a consent in force shows as “Paused”. The same block says when a
consent on file is for a number that is not a US one. A text that was already queued is dropped with the reason and
listed under Settings → Client updates → “Not sent or not confirmed”.

**Consent (TCPA).** A client turns texts on or off in Portal → Profile. The wording they see says that message
frequency varies, message and data rates may apply, reply STOP to stop, HELP for help, and that consent is not a
condition of service; that exact wording, the number, the time, the language and the source are stored in
`sms_consents`. Staff can record a consent given outside the portal only with a note saying how and when; it is stored
and shown as “Recorded by staff”. A record is never edited or deleted through the app: withdrawing stamps it, and
agreeing again is a new record. If the client's phone number changes, texts pause until they agree for the new number.
Have your attorney review the consent wording and your use of it: this is a careful default, not legal advice.

**Limits.** At most 3 texts and 6 emails per client in 24 hours; the rest are skipped, not saved up. One message per
client, event, subject and channel (a unique key), so a repeated or simultaneous trigger sends once. Document requests
are announced at most once a day per client and team messages at most once an hour. Texts are held between 9 p.m. and
8 a.m. and go out with the next run after that; a message still unsent after 72 hours is dropped. The quiet hours are
judged where the client is, as far as the record says: in the workspace's own time zone (Settings → Client updates;
`APP_TIMEZONE` until one is chosen) **and** in every time zone of the US state on the client's address. A text goes out
only when it is inside 8 a.m. to 9 p.m. in all of them. With no usable state on the address, Eastern and Pacific are
both applied (11 a.m. to 9 p.m. Eastern). The state must be a two-letter postal abbreviation to be recognised.

**When it is sent.** Right after the request that caused it has finished (Next.js `after`), or by the scheduled job
(`/api/jobs/run`) for anything still queued, including texts held overnight and the “window passed” event, which only
the scheduled job detects. The job must therefore run at least once during the day; `vercel.json` schedules it at
09:00 and 20:00 UTC. 09:00 UTC is night across the US, so texts go out with the 20:00 UTC run (3 or 4 p.m. Eastern,
noon or 1 p.m. Pacific, 10 a.m. in Hawaii).

**What is recorded.** Each attempt is a row in `client_updates` and a message on the client's Messages tab with its
channel, status and the provider's id. A failure is saved as failed with the reason and listed under Settings → Client
updates → “Not sent or not confirmed”. With the development `log` driver nothing is delivered and the message is marked “Not delivered”.

**Replies.** `POST /api/webhooks/twilio` accepts a request only when its `X-Twilio-Signature` matches (HMAC-SHA1 over
the webhook URL plus every form field, keyed with the Auth Token) and it names your Account SID. A reply that
contains STOP, QUIT, END, REVOKE, CANCEL, UNSUBSCRIBE or “opt out” anywhere (the words 47 CFR 64.1200(a)(10) names),
or a plain refusal such as “no more texts” or “no más mensajes”, revokes consent for every client record with that
number. This errs towards stopping: “see you at the end of the week” switches texts off too. Twilio's own block only
follows single-keyword replies, so the consent record here is the stricter of the two. After a STOP only the client can
turn texts back on, in their portal profile: staff cannot record a consent over it (the database refuses it). START, YES
or UNSTOP is only noted on the timeline: the client must agree again in the portal (Twilio itself lifts its own block
and sends its standard reply; this app still sends nothing until there is a new consent). Any other reply is saved as
an inbound text on the client, and **texts to that client pause** until a staff member has read it on the client's
profile and said whether it asks to stop (a request to stop counts however it is worded). When several client records
carry the number, the reply goes to the one whose consent is in force for that number, then to the one texted most
recently. If that still does not settle it, it is filed on every record that holds a consent in force for the number;
records of different workspaces are told that a reply arrived, not its wording. With no such record nothing is guessed:
the message is kept with no workspace, also when every record that carries the number is in one workspace, because
carrying a number is not a reason to be shown what its owner wrote. Such a message is visible only in the database
(`sms_inbound` where `org_id` is null); the scheduled job reports how many are unreviewed (`unmatchedInboundTexts`) and
logs a warning. Every record that carries the number is looked at, however many there are, and a STOP ends all their
consents in three statements: a workspace cannot crowd a reply or a STOP out by typing the number onto records of its own.

### The Get set up page

Owners and admins can follow these steps in the app at `/app/setup` (linked from Settings → Integrations). It reads the
real configuration, names the environment variables still missing (names only, never values), shows the webhook
address to paste into Twilio and whether Twilio has reached it, and has "Send a test email to me" and "Send a test
text to me" buttons that show the provider's own answer. A step is ticked only when its check passes; A2P 10DLC
registration cannot be checked from the app and is never ticked.

The test text is held to the rules of every other text, because it goes to a number somebody typed: it is refused for a
workspace the operator has not approved (or one renamed since), it goes to a US number only, never to a number that has
replied STOP to this deployment, and it does not carry the workspace's name. At most 3 a day per person and per
workspace, and 50 a day for the whole deployment.

### Twilio setup

1. Create a Twilio account (twilio.com) and upgrade it from trial; a trial account can only text numbers you verified.
2. Buy a phone number with SMS capability (Phone Numbers → Buy a number).
3. Register for US messaging. This is required by the carriers, takes days, and nothing sends reliably without it:
   - **A2P 10DLC** for an ordinary ten-digit local number: Messaging → Regulatory Compliance → register your **Brand**
     (legal business name, EIN, address), then a **Campaign** (use case “Account Notification” or “Customer Care”;
     describe that clients opt in on their portal profile, paste the consent wording and a sample message, and give
     your privacy policy and terms URLs). Texts from an unregistered ten-digit number to US numbers are blocked
     (Twilio error 30034).
   - or **toll-free verification** if you bought a toll-free number (Twilio error 30032 until it is verified).
4. Create a **Messaging Service** (Messaging → Services), add the number to its Sender Pool and link it to the approved
   campaign. Note its SID (`MG…`).
5. In the Messaging Service → Integration, choose “Send a webhook” and set the **Request URL** to
   `https://<your-app-domain>/api/webhooks/twilio`, method **HTTP POST**. (Without a Messaging Service, set the same
   URL on the phone number under “A message comes in”.) Settings → Client updates shows the exact address to copy.
   It must match `APP_URL` exactly: the signature is computed over the URL.
6. Leave Twilio's default opt-out handling on. It answers STOP, START and HELP itself and blocks further texts to a
   number that replied STOP (error 21610).
7. Set the environment variables and redeploy:

   | Variable | Value | Secret? |
   |---|---|---|
   | `SMS_DRIVER` | `twilio` | No |
   | `TWILIO_ACCOUNT_SID` | `AC…` from the Twilio Console dashboard | No |
   | `TWILIO_AUTH_TOKEN` | the primary Auth Token from the same page | **Yes** |
   | `TWILIO_MESSAGING_SERVICE_SID` | `MG…` from step 4 (recommended) | No |
   | `TWILIO_FROM_NUMBER` | only without a Messaging Service: the number as `+15551234567` | No |

8. Approve your own workspace for text messages (`npm run outreach:approve -- <org-slug>`): until then it sends no
   text, the test included. Then open Settings → Client updates. “Text messages: Connected” means the variables are
   present, not that Twilio accepted a message. Turn on one event, agree to texts as a test client with your own phone
   (a US number), trigger the event, and check the client's Messages tab. If you rotate the Auth Token, update
   `TWILIO_AUTH_TOKEN` at the same time or every webhook is refused (403).

Not verified: nothing here has been run against the live Twilio service. The request format, the signature (checked
against the worked example in Twilio's documentation) and the keyword list follow Twilio's documentation as read on
2026-11-19: https://www.twilio.com/docs/messaging/api/message-resource, https://www.twilio.com/docs/usage/security,
https://www.twilio.com/docs/messaging/guides/webhook-request, https://help.twilio.com/articles/223134027.

### Resend setup (email)

1. Create an account at resend.com.
2. Domains → Add Domain. Use a subdomain you do not receive mail on (for example `updates.your-domain.com`).
3. Resend lists the DNS records to create at your DNS provider. Copy the names and values from that screen, not from
   here; they are specific to your domain and region. Typically: a **TXT** record `resend._domainkey.<domain>` (DKIM),
   and for SPF an **MX** and a **TXT** record on `send.<domain>`. Newer domains may show **CNAME** records instead; on
   Cloudflare keep those “DNS only”. Adding a DMARC record (`_dmarc`, TXT) is recommended.
4. Wait until the domain shows as verified, then create an API key (API Keys → Create, “Sending access”).
5. Set `EMAIL_DRIVER=resend`, `RESEND_API_KEY=re_…` (secret) and `EMAIL_FROM="Your Business <no-reply@updates.your-domain.com>"`
   on the verified domain, and redeploy.

Client update emails are sent from that address with the agency's name as the display name; replies go to the reply
address saved on the Leads page when there is one. Resend delivery has not been verified from this codebase.

### Calls

No call is ever placed by this product, and no dialer or AI voice feature exists. Generally, under the TCPA (47 U.S.C.
§ 227 and 47 CFR § 64.1200) a call that uses an artificial or prerecorded voice, which the FCC has said includes
AI-generated voices, needs the called person's prior express consent, and prior express **written** consent when it is
telemarketing. That is a different and stricter consent than the text consent recorded here, and it is out of scope.
Staff who phone a client log the call by hand on the Messages tab.

Not built, on purpose:

- **Calls of any kind, auto-dialling and voicemail drops.** A dialled, prerecorded or AI-voice call generally needs the called person's prior express consent under the TCPA, in writing when it is marketing, and nothing here records one.
- **Texts to partners.** A marketing text needs the recipient's prior express written consent, and a business found through public contact details has given none; partners are emailed only and their phone number is kept for the agency's own use.
- **Texts to anyone else without a recorded consent.** The only automatic texts go to a client who agreed in the portal (file updates) or a lead who ticked the text box on the enquiry form (follow-up), at the number that consent names, until they reply STOP. Every text goes to a US number, from a workspace the operator has approved.

## Scheduled jobs

One code path (`src/lib/automation/jobs.ts`) runs the automation sweeps for every active organization and cleans expired
sessions, reset tokens, invites and rate-limit rows. Two ways to invoke it:

- `POST /api/jobs/run` with `Authorization: Bearer $CRON_SECRET` (404 when `CRON_SECRET` is unset, 401 when it is wrong).
- `npm run jobs:run` — makes exactly that call against `APP_URL` (or `JOBS_URL`). The app must be running. Exit code 0 = ran
  with no failures; 1 = unreachable, wrong secret, or at least one organization failed; 2 = `CRON_SECRET` not set.

Call it every 15–60 minutes from your host's scheduler.

- **Retries are safe.** Each automation run is unique per automation, subject and cooldown window, so running twice creates
  no duplicate tasks, messages or notifications (tested).
- **Failures are visible.** Each organization runs in its own transaction; a failure is rolled back, written to `job_runs`
  (Automations → Scheduled checks), and the organization's owners/admins get one in-app notification per day while it lasts.
  Other organizations still run (tested).

## AI provider (Claude)

**Status: built to the current API, not yet proven live.** The Anthropic adapter (`src/lib/ai/provider.ts`) calls the
Messages API through the official SDK, `@anthropic-ai/sdk` 1.5.0 (pinned). It is tested against a mocked API
(`tests/unit/ai-anthropic.test.ts`). It is proven live only once `npm run ai:prove` has passed with a real key (below);
until then, treat the connection as unverified.

- **Turning it on.** `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` (a secret). Optional: `AI_MODEL` (default
  `claude-opus-5-5`) and `AI_EFFORT` (`low`, the default, `medium` or `high`). Cheaper models for `AI_MODEL`:
  `claude-sonnet-5-5` ($2 / $10 per million input / output tokens) and `claude-haiku-5-5` ($0.10 / $0.50), against
  $4 / $20 for Claude Opus 5.5. Write a model id exactly so, never with a date suffix. A provider chosen without its key
  changes nothing: the built-in wording is used, Settings → Integrations shows "Needs credentials" and the setup page
  names the missing variable. Every workspace starts with 0 AI credits, so nothing calls the model until the operator
  grants some. Steps for Vercel: docs/DEPLOY-VERCEL.md, "Connect AI".
- **The request.** One call per use of a feature, on the beta Messages endpoint: `model`; `max_tokens` 16000 (the
  model's thinking counts toward it, so it is generous; how long a reply should be is said in each prompt); `output_config:
  { effort }`; the server-side refusal fallback (`anthropic-beta: server-side-fallback-2026-07-01` with `fallbacks:
  "default"`: if the model declines, the API re-runs the request on a fallback model); the system prompt; one user
  message. No `temperature`, `top_p`, `top_k` or `thinking`: current models reject them, and Opus 5.5 always thinks,
  adaptively. The Setup test's call has a 4000-token cap.
- **The reply.** Only `text` blocks after the last `fallback` block are read; thinking blocks never are. Nothing but
  `stop_reason: end_turn` is used: `refusal` (the fallback declined too), `max_tokens` (cut off) and every other reason
  become "AI unavailable" with a plain reason, the standard wording is kept and the credits are given back.
- **Time.** One overall deadline of 45 s ends the whole call, retries and waits included. One attempt may use all of it:
  a reply that is not streamed arrives only once it is complete, so a slow but valid reply is used if it comes within
  45 s. The SDK retries once after a rate limit, an overload, a server error or a dropped connection, waiting as
  `retry-after` asks, within what is left of the 45 s. Pages and actions allow 60 s (`maxDuration`).
- **Errors.** Read from the SDK's typed errors, never from message text: 401 "the AI key was refused", 403 "the AI key
  is not allowed to make this request", 404 "the AI model “…” was not found", 400 "the AI service rejected the request
  (HTTP 400)", the monthly spend limit of the Anthropic account (429 with the error code `enforced_spend_limit_reached`)
  "the AI account has reached its monthly spending limit; it resumes when the limit resets or is raised in the
  Anthropic Console", any other 429 and 529 "the AI service is busy, try again in a minute", other 5xx "the AI service
  had a problem (HTTP n)", any other status "HTTP n", no answer within the deadline "the AI service took too long to
  answer", no connection "the AI service could not be reached". Only busy, failing, slow and unreachable count as
  passing on their own; the spend limit does not. Staff see it inside the "AI unavailable (…)" note; portal clients
  never do.
- **Logs.** One line per call: `[ai] anthropic model=… effort=… stop=… in=… out=… ms=… served=… fallback=yes|no
  request=req_…`, or `error=… status=… type=… code=…` when the call failed (`code` is the API's structured error code,
  such as `enforced_spend_limit_reached`, when it sent one); info level, warn when the reply was not used. Never the
  prompt, the reply, the key or the API's wording of an error. The SDK's own log level is fixed at `warn`, so
  `ANTHROPIC_LOG=debug` cannot make it print request bodies, and its trace spans (only when the app registers an
  OpenTelemetry tracer) carry metadata only.
- **What is sent, feature by feature.**
  - *Letter wording suggestion* (5 credits): the letter with every line except its connective wording (salutation,
    linking sentence, closing courtesy, sign-off) replaced by a marker, and a fixed instruction. No name, address,
    account, amount, date, reason or status leaves the server.
  - *Progress note polish* (2 credits): the note's two connective sentences ("Here is where your case stands." and "We
    will let you know about each response.", or the Spanish), with markers for the greeting, the counts and the
    results-vary sentence, and a goal that lists the courtesy words below. The client's name is not sent: the greeting
    is built with a placeholder and locked. A reply is used only if it keeps every marker in place, the same lines and
    the same number of sentences in each stretch of wording (no preface, no echoed tag, no added or dropped sentence),
    adds no number, and passes two word checks. First, the reworded sentences (only the wording between the markers,
    so the locked counts and results-vary sentence are not read) may use only the courtesy words of the note's
    language, compared without letter case or accents, with spaces and ordinary punctuation between them and no other
    character (no digit, symbol, emoji or formatting); any other word or character discards the reply (`COURTESY_WORDS`,
    `BESIDE` and `COURTESY_PHRASES` in `src/lib/ai/assistant.ts`):
    - English: a, about, all, an, and, answer, answers, any, are, arrive, arrives, as, at, be, below, can, case, come,
      comes, contact, each, every, file, for, from, get, gets, has, have, hear, here, here's, how, i, i'll, if, in,
      informed, is, it, it's, keep, know, let, let's, look, message, messages, news, notify, now, of, on, once, or, our,
      overview, patience, please, posted, question, questions, receive, replies, reply, response, responses, share,
      status, summary, tell, thank, thanks, that, that's, the, things, this, to, touch, update, updates, us, we, we'll,
      we're, what, when, where, will, with, you, you'll, your; "quick", "short" and "brief" only next to update,
      updates, summary, overview or look; "updated" only right after "you"; "stand" and "stands" only after "where";
      and the phrase "as soon as".
    - Spanish: a, actualización, ahora, al, aquí, así, avisaremos, avisarle, cada, caso, cómo, compartimos,
      compartiremos, comunicaremos, con, contacto, contaremos, cuando, cuanto, de, del, el, en, enviaremos, es,
      escríbanos, escribiremos, escribirnos, esta, está, están, estado, estaremos, este, esto, expediente, gracias,
      haremos, informada, informadas, informado, informados, informamos, informaremos, informarle, la, las, le, les,
      llega, llegue, lleguen, lo, los, mantendremos, mantenerle, más, mensaje, mensajes, nosotros, noticias,
      notificaremos, novedades, nuestras, nuestros, o, paciencia, para, por, pregunta, preguntas, presentamos, puede,
      que, recibamos, recibimos, reciente, respuesta, respuestas, resumen, sabrá, saber, si, situación, sobre, su, sus,
      tanto, tiene, todas, todos, un, una, usted, va, vamos, y; "breve" only next to resumen or actualización; and the
      phrase "tan pronto como".

    The lists have no word for a result (credit, a score, an item, an account, a report, a removal, an improvement, an
    approval, a win), for a prediction or for how soon something will happen ("soon" and "pronto" only inside the two
    phrases), no praise or feeling, no negation, and no pair that says something goes away ("off", "away", "up" and
    the Spanish "se" are not on them), so a promise worded in a new way is refused as well: it would need a word that
    is not on them ("We will win your case.", "Those negative items are history.", "Ganaremos su caso." are refused). A refused reply is not charged (the credits are given back) and the drafted note is used. Second, the
    whole note must pass the claims the guide rejects in model-written text (below).
  - *Credit guide answer* (1 credit): the matched knowledge entries, generic step labels (never the person's own steps)
    and the question, masked in this order: Social Security numbers (9 digits, or 3-2-4 groups split by spaces,
    dashes or dots), card numbers, email addresses and phone numbers; what the app holds about the client, wherever it
    appears as written on file (the address's first and second lines, city, ZIP code, SSN last four, and the date of
    birth in common formats such as 1985-03-14, 03/14/1985, 3/14/85, 14/03/1985, March 14, 1985 and 14 de marzo de
    1985: in the portal the signed-in client's, for staff asking from a client's page that client's); the names the app
    knows (in the portal the client's own name parts; for staff asking from a client's page also the creditors and
    collectors on file; for staff asking anywhere else none); dates; street addresses written as a number, one to four
    words and a street type (St, Ave, Rd, Blvd, Dr, Ln, Ct, Way, Circle, Place, Parkway, Terrace, Highway, Trail,
    Square, Plaza, Loop, Pike, Row, Cove, Crossing, Crescent, Expressway, Freeway, Turnpike, Alley, and their
    abbreviations), or in Spanish order ("Calle Mayor 12", "Avenida Reforma 222, depto 4"), with a unit; city-state-ZIP
    lines; amounts; and any other number of 4 or more digits. Masking works by matching, so anything else typed is sent
    as written: an address, name or city the app does not hold and that is written another way (an address with no
    street type, for example), the state on its own, short numbers, and in the portal a creditor's name. The model's
    answer is then shown only if it passes the claims guard and the stricter rules for model-written text
    (`findGeneratedClaims` in `src/lib/guide/llm.ts`): no promise ("we promise", "for sure", "le prometemos"); no
    "will", "going to" or Spanish future with a score rising, an item coming off or being removed, or an approval
    ("this will raise your score", "your score will…", "su puntaje subirá", "will be approved"); no sentence that pairs
    a word of likelihood, timing or what usually happens (should, expect, likely, probably, about to, on track, soon,
    will, going to, usually, typically, normally, often, generally, commonly, in most cases, most of the time, tend to,
    as a rule, many or most people or clients; debería, probablemente, a punto de, pronto, esperar, va a, a verb in the
    future, normalmente, generalmente, habitualmente, por lo general, suele, a menudo, casi siempre, en la mayoría de
    los casos, muchas personas) with a result (a score going up, credit or a history getting better or clean, an item
    coming off or being removed, an approval, good results or loving them: "great results", "you will love the
    results", "excelentes resultados", "le encantarán los resultados"); and no suggestion to dispute accurate
    information. These are patterns, not an understanding of the text: a false alarm shows the vetted entry instead,
    and a result stated with none of those words ("once the errors are fixed, your score improves", "your score could
    improve") is not caught.
  - *Setup connection test* (free): one fixed request, "Reply with the single word CONNECTED and nothing else." No
    client or workspace data.
- **Setup test.** "Test the AI connection" on the Get set up page, for owners and admins (`settings:manage`). Limits: 5
  an hour per person, 10 an hour per workspace and 100 a day for the deployment, spent only when a call is made. A pass
  records the time and the provider and model (`settings.setup_ai_test_at`, `settings.setup_ai_test_provider`) and ticks
  the AI step; a failure that will not pass on its own (the key, the model or effort, a rejected request, the account's
  monthly spending limit, a refusal, a wrong answer) removes that record, and a busy, failing or unreachable service
  leaves it. The message says what to do next. Only a model that was not found (404), or a rejected request (400) while
  `AI_MODEL` or `AI_EFFORT` is set to something other than the default and the API gave no error code, points to
  `AI_MODEL` and `AI_EFFORT`. A rejected request with the defaults says the cause is elsewhere (a beta feature the
  organization is not enabled for, for example); one with an error code names it (such as `organization_on_hold`); both
  point to the `[ai]` log line and to `npm run ai:prove`. The spending limit says AI wording is off until the limit
  resets or is raised in the Anthropic Console. Every attempt writes a `setup.test_ai` audit entry with the provider and
  the outcome only (`settings` or `request` for a rejected request, `spend_limit` for the limit). The AI step is done
  only after a pass with the provider and model in use now.
- **Proving it live.** From a checkout with the test database (`npm run env:setup`), with the key in the shell for that
  one command (never in a file):

  ```bash
  AI_PROVIDER=anthropic ANTHROPIC_API_KEY=<key> AI_MODEL=claude-opus-5-5 npm run ai:prove
  ```

  `tests/live/ai.live.test.ts` makes one real call per feature on the synthetic client Jordan Rivera
  (`tests/fixtures/jordan-rivera.ts`): the letter suggestion, the progress note in English and in Spanish, the guide for
  staff and for the portal (with the fixture's identifiers on file, as the app passes them), then the Setup connection
  test. For each it prints the request (system and user text), the raw reply, the stop reason, tokens, time and request
  id, and what the feature did with the reply; for a call that failed, the API's own explanation too, which the app
  itself never shows or logs. It asserts that
  every call finished (`end_turn`), that the Setup test passed and was recorded, and that no personal data of the fixture
  (names, address, account and SSN digits, date of birth, email) is in any request. Six short calls cost a few cents. A
  reply the safety checks discard is printed, not failed. Under `npm test` (no `AI_LIVE=1`) the file is skipped; the same
  privacy assertion runs on every test run against a stand-in (`tests/unit/ai-no-pii.test.ts`).
- **Not verified.** No call has reached the real API from this codebase: the request shape, the beta header, the
  fallback, the error mapping and the stop-reason handling are tested against a mocked API and a local stand-in only.
  How often real replies pass the checks, and real latency and token use, are unknown until the proof and the first
  weeks of use. The OpenAI-compatible adapter is unchanged apart from its error kinds and the 45 s deadline, and is
  tested against a mocked API only.

## AI credits

AI wording is metered so the platform operator can charge for it. Nothing about AI is free, apart from the Setup
page's connection test: one tiny fixed request, rate limited, paid by the deployment.

- **Prices** (one place: `AI_COSTS` in `src/lib/ai/credits.ts`): letter wording suggestion 5, client progress note polish 2,
  credit guide answer worded by AI 1. These are credits, not money; what a credit costs is the operator's decision and is
  not stored in the app.
- **When credits are taken.** At the moment the model is called, and only kept if an AI result passes the safety checks and
  is returned. If the provider fails, or its output is discarded, the same amount is written back as a `refund` row that
  points at its charge (`ref_id`; the database allows one refund per charge). A letter suggestion is charged when it is
  shown, whether or not staff then accept it.
- **Interrupted requests.** A charge is a reservation until its outcome is recorded (`settled_at` on the `use` row, or a
  refund row). If the request is killed between the charge and the result (host time limit, deploy, crash), or the refund
  cannot be written, the scheduled jobs (`POST /api/jobs/run`, see above) refund every charge that has had no outcome for
  10 minutes; the response reports the count as `aiRefunds`. **This needs the scheduler to be running** (`CRON_SECRET` set
  and the host calling the route). Without it such a charge stays until `npm run jobs:run` is run by hand. The staff
  and portal layouts set `maxDuration = 60`, above the 45 s limit on one AI call (retries included); the host plan must
  allow 60 s functions.
- **Paid results are kept.** A letter suggestion is stored for the letter version it was made from (`letter_suggestions`,
  migration 0013) and shown again from the letter page, so a reload or a lost response does not lose it and asking again for
  the same version is not charged again. It is not shown once the letter has a newer version; that is not refunded. The
  polished progress note is **not** stored: if its response is lost, pressing the button again is charged again.
- **What a letter suggestion is.** Tailoring (`src/lib/letters/tailor.ts`): the model rewords only the connective wording
  of a letter (salutation, linking sentences, closing lines, sign-off) in a voice picked by a seed worked out from the
  client's id, so a client's letters keep one voice. Everything else is replaced by markers before it leaves the server:
  the standing protected-rewriting rules, plus the client's name and address, the recipient, the creditor, every sentence
  of the reason, every reported status and every enclosure line. The instruction to the model is made of fixed phrases. The
  result is discarded, and not charged, unless the protected content is unchanged, the claims guard passes, the wording
  makes no demand, legal claim, threat, deadline, promise or new request, and a dispute letter still passes the
  specificity check.
- **Automatic tailoring is an agency setting, off by default** ("Tailor wording automatically when a letter is drafted",
  AI assistant → AI credits, stored as `settings.letter_auto_tailor`, audited). On, each drafted letter is tailored once at
  the normal price and a safe result is saved as a new draft version marked as AI wording. Approval by a person is unchanged.
- **With no credits or no provider** the app behaves exactly as it does without AI: the deterministic text is used. Staff see
  "AI wording is off: no AI credits left" or "…no AI provider connected". Portal clients see the normal vetted answer and
  nothing about credits.
- **Portal clients and the agency's credits.** Off by default: portal guide questions get the vetted knowledge-base
  answer, the model is not called and nothing is charged. An owner or admin can turn it on under AI assistant → AI credits
  (stored as `settings.portal_ai_guide`, audited). When on, each client is limited to 10 AI-worded answers in any 24 hours
  (`PORTAL_GUIDE_DAILY_CAP`), then gets the vetted answer. There is no per-workspace cap: the ceiling is 10 credits per
  portal client per day. Identical repeated questions are not cached and count toward the cap.
- **Ledger.** `ai_credit_ledger` is append-only (a trigger blocks UPDATE and DELETE, including for the system role; the one
  permitted change is setting `settled_at` once on a `use` row; rows go only when their organization is deleted). The balance is `sum(delta)` — there is no balance column. Tenant requests can
  only read it (staff of the organization); nobody can insert through the tenant connection.
- **Adding credits.** `npm run credits:grant -- <org-slug> <amount> [note]` on the server, with `DATABASE_URL` set. Amount is
  a whole number from 1 to 100000. It writes a `grant` row and an `ai_credits.granted` audit entry and prints the new
  balance. It does not take payment. New workspaces start at 0; the demo seed gives the demo agency 100 labelled sample credits.
- **Where staff see it.** AI assistant page → "AI credits": balance and price list for all staff, the last 20 ledger
  entries for owners and admins. The balance is also shown beside "Suggest better wording" on a letter.
- **Not built.** Online purchase, invoices, a money price per credit, low-balance alerts, caps for staff or per workspace, and a
  cross-workspace usage report for the operator (query `ai_credit_ledger` directly for now). The provider's own bill is
  not reconciled against credits. The credit flow is tested against a stand-in provider; the provider calls themselves
  are proven live only by `npm run ai:prove` (see [AI provider (Claude)](#ai-provider-claude)).
