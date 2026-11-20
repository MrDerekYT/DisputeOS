# Integrations — what is real and what is not

Settings → Integrations shows this live, derived from configuration. **"Verified" means exercised against the real
third-party service from this codebase. None of the paid third-party integrations below have been.**

| Integration | Status | Notes |
|---|---|---|
| PostgreSQL | **Active, verified** | Tested against PostgreSQL 16. Works on any managed Postgres that lets you create the `disputeos_rls` role (see ENVIRONMENTS.md). |
| Document storage | **Active, verified** | Encrypted files on a server volume (`STORAGE_DRIVER=disk`, `STORAGE_DIR`) or, for hosts with no persistent disk such as Vercel, encrypted rows in the database (`STORAGE_DRIVER=db`, table `stored_objects`). Both verified by tests. **S3-compatible storage is not built.** |
| Email — Resend | Implemented, **not verified live** | `EMAIL_DRIVER=resend` + `RESEND_API_KEY` + verified domain. The default `log` driver writes to `.storage/outbox/` and delivers nothing; the UI marks such messages "Not delivered". It is for development and test only: staging/production refuse to start unless `EMAIL_DRIVER=resend`. |
| Email — none (`EMAIL_DRIVER=disabled`) | **Manual**, verified by tests | The explicit way to run staging/production without an email provider. Nothing is sent or logged; invitations show a one-time link to pass on; client emails are recorded as not delivered; lead follow-up stays off; **password reset by email is unavailable** and the reset page says so. |
| AI — Anthropic / OpenAI-compatible | Implemented, **verified against a mocked API only** | `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` (model via `AI_MODEL`, default `claude-sonnet-5-5`), or `AI_PROVIDER=openai` + `AI_BASE_URL` + `AI_API_KEY` + `AI_MODEL`. The deterministic engine is complete without them. |
| AI credits (metering) | **Works, tested; buying online is not connected** | Every AI result that is returned costs credits from the workspace's balance (`src/lib/ai/credits.ts` holds the price list; ledger in `ai_credit_ledger`, migration 0012). A workspace with no credits, or with no AI provider, gets the standard non-AI wording. There is no checkout: the platform operator adds credits with `npm run credits:grant -- <org-slug> <amount> [note]`. Selling credits in the app needs a payment processor (e.g. Stripe), a checkout and a webhook that writes `purchase` rows. |
| Text messages — Twilio | Implemented, **verified against a mocked API only**; off by default (`SMS_DRIVER=disabled`) | Short “there is an update, sign in to see it” texts to clients who agreed to them, for the events an agency switches on under Settings → Client updates. Needs `SMS_DRIVER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_FROM_NUMBER`, plus the provider-side registration. See “Client updates by text message and email” below. The same driver sends the two follow-up texts to leads who ticked the text-message box on the enquiry form (“Referral partners and lead text follow-up”). Until then Settings shows “Not connected” and staff log calls and texts by hand. |
| Payment processing (Stripe etc.) | **Manual** (no processor integration) | Payments are recorded manually; there are no Stripe settings. Also constrained by the CROA advance-fee rule. |
| Credit Connect (consent-gated import pipeline) | **Pipeline works, tested; no live provider** | Upload, inbound REST API, and an adapter framework with a dev-only sandbox. Nothing is imported automatically from a real provider, so Settings shows "Test stand-in only" in development and "Manual path in use" in staging/production. See `docs/CREDIT_CONNECT.md` |
| Public REST API + API keys | **Works, tested** | `/api/v1/*`, OpenAPI at `/api/v1/openapi.json` |
| Live provider adapters (Array, IDIQ, bureaus) | **Manual** (no adapter; needs partner approval) | Provider APIs are partner-gated and require a permissible purpose and client authorization; there is no legitimate unauthenticated access. Import by upload/CSV today. |
| Electronic signatures (external provider) | **Manual** (no provider integration) | Typed-name e-signature in the portal with timestamp/IP/text hash is provided. |
| Certified mail (Lob, etc.) | **Manual** (no provider integration) | The approved PDF is produced; a person mails it and records tracking. |
| Custom domains for agency websites | **Automatic** with `VERCEL_API_TOKEN` + `VERCEL_PROJECT_ID` (`VERCEL_TEAM_ID` for a team project); otherwise **manual** | An agency connects a domain it already owns on its Website page; its `/a/<workspace-slug>` address keeps working. With the Vercel variables set, the app adds the domain to the project, shows the DNS records and marks it connected only when Vercel reports it verified and correctly configured. Without them the domain stays "not connected yet" until the platform operator adds it in Vercel and runs `npm run domain:verify -- <domain>`. Buying a domain is not built in. Steps: docs/DEPLOY-VERCEL.md. Tested against a mocked API only. |
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
| SMS | Manual until Twilio is connected (the default) | Text/call from your own phone and log it on the client's Messages tab ("nothing is sent") | A Twilio account with a sending number registered for US messaging and the four variables in “Client updates by text message and email”; each client's own agreement to texts. Two-way texting from the Messages tab is not built: the integration only sends the automatic client updates and the consented lead follow-up texts, and records replies |
| External e-signature | Manual | Typed-name signature in the portal (name, time, IP, hash of the text shown), or staff record a paper consent | Only if counsel requires a third-party signing service: an account with it and the integration |

## Leads follow-up and the credit guide: what they need

| Feature | Works with nothing connected | Needs | What is not there |
| --- | --- | --- | --- |
| Leads page, enquiry form, tagged links, counts | Yes | Nothing | — |
| Automatic follow-up email to leads | **No.** With the `log` driver nothing is sent and nothing is recorded as sent; the Leads page says "Email is not connected" | `EMAIL_DRIVER=resend` + `RESEND_API_KEY` + a verified sending domain for `EMAIL_FROM`; the agency's postal address and reply address saved on the Leads page; the switch on. The welcome is sent right after the enquiry; the follow-up and last note need the scheduled job below to be running | **Replies are not read.** They go to the agency's reply address; staff press "They replied" or "Asked to stop". Reading them needs an inbound-email webhook, which does not exist. The From line is `"<Agency name>" <address from EMAIL_FROM>`; the Resend driver, including this, is not verified against the live service. A step whose result was never recorded stays "not confirmed" and is not re-sent |
| Text follow-up to leads | **No.** Off by default, and nothing is texted or offered on the form until a text service is connected | The lead follow-up switch on, the text switch on (Leads page), `SMS_DRIVER=twilio` with its credentials, and **the lead's own tick** in the separate text-message box on the enquiry form. See “Referral partners and lead text follow-up” | No tick, no text: that lead gets email only. Two texts at most (welcome, follow-up after 3 days). Not verified against live Twilio |
| Referral partner email sequence | **No.** Off by default; with the `log` driver nothing is sent and nothing is recorded as sent | The switch on (Partners page), the same postal and reply addresses as the lead follow-up, `EMAIL_DRIVER=resend`, and the scheduled job running on business days | **Email only: partners are never texted or called.** Replies and bounces are not read: staff press “They replied”, “Interested”, “Not interested” or “Bounced”. No scraping, bought lists or directory import: the agency adds partners itself. Not verified against live Resend |
| Credit guide (chat box) | Yes — answers come from the vetted knowledge base by keyword match | Nothing. Optional: `AI_PROVIDER` (same settings as the AI row above) lets a model re-phrase the retrieved entries | With AI on, the question (names, numbers, amounts and addresses masked) is sent to the provider. Output is discarded and the vetted text shown when a pattern rule matches a promise, an unknown number or web address, or a prompt marker; the rules are patterns, not a proof. Tested against a fake provider only |

## Referral partners and lead text follow-up

Code: `src/lib/partner-emails.ts` (wording, timing), `src/lib/partner-import.ts` (reading a list),
`src/lib/partner-outreach.ts` (sending, opt-out, bounces), `src/lib/outreach-approval.ts` (the operator's approval),
`src/lib/partners.ts` (what staff record), `src/lib/lead-texts.ts`, `src/lib/lead-outreach.ts` and `src/lib/us-phone.ts`
(lead texts), the pages under `/app/partners`, `/unsubscribe/partner/<token>`, `/api/unsubscribe/partner/<token>` and
`/api/webhooks/resend`, migration `0028_partner_outreach.sql`.

**Who is on the list.** Businesses that can refer clients (real estate agents, loan officers, mortgage brokers, car
dealerships, tax preparers, property managers), added by the agency itself: one at a time, or as a list pasted or
uploaded as CSV (a header line with an `email` column; up to 200 rows per import; invalid rows are left out and named;
an address repeated in the list or already on file is skipped). The person adding them confirms the contacts came from
public business contact details or the agency's own contacts, and who confirmed it and when is stored on every row.
Nothing is scraped, bought, looked up or imported from a directory.

**What is sent.** Three plain-text emails per partner: an introduction, a follow-up 4 business days later and a last
note 9 business days after the introduction, in English or Spanish, with wording per category. They say what the agency
does (helps consumers review their credit reports and dispute inaccurate information), say plainly that no result, score
or loan approval can be promised, state nothing about the partner beyond the category and city on the record, and link to
the agency's published website when there is one. Every email says it is a business solicitation from the agency,
shows the agency's name and postal address and carries a one-click opt-out link (CAN-SPAM, 15 U.S.C. § 7704). Subject
lines name the agency and say what the email is. All of it passes the marketing claims guard.

**What has to be true before anything goes out.** The platform operator has approved the workspace for outreach (see
"Operator approval" below); an owner or admin switched the sequence on (Partners page; off by default); the mailing
address and reply address are saved (the same two the lead follow-up uses); email is really connected; and the agency's
own name does not read as a prohibited claim, carry a web address or run past 80 characters (it is in every subject and
From line). Then the scheduled job sends with **no approval of each message**: on business days in the workspace's time
zone, at most 10 per run and 40 per agency in any 24 hours (10 during the first 14 days after approval), and at most
`OUTREACH_PLATFORM_DAILY_EMAILS` (default 500) across every workspace of the deployment. Each (partner, step) goes once.
A step is claimed through a unique key before the email is handed over, under one lock for the deployment that makes
all of these limits exact when runs overlap. With the two runs a day scheduled in `vercel.json` that is at most 20
emails a day per agency (one run is in the early morning, US time); schedule more runs during the day to reach the limit.

**The wording is fixed.** No model writes any part of a partner email. An earlier option to let an AI provider reword
the connecting sentences was removed: its only safeguard on free text was a list of phrases, which can always be worded
around, and nobody read the result before it was sent. The setting `partner_outreach_ai` is no longer read and is
deleted when the Partners form is saved. The checks that were written for it (`acceptPersonalised` and
`findFamiliarityClaims` in `src/lib/partner-emails.ts`) are kept, with their tests, for a future version in which a
person approves each reworded email; the sender does not import them.

**Operator approval.** Sign-up is open and unverified, and every workspace sends through the deployment's one email
service and one text number. So nothing unattended (partner emails, lead follow-up texts) goes out for a workspace until
a person at the operator has looked at it and run

    npm run outreach:approve -- <org-slug>          # approve under the business name it has now
    npm run outreach:approve -- <org-slug> --revoke # withdraw

The approval is two columns on `organizations` (`outreach_approved_at`, `outreach_approved_name`; migration 0028) that
no tenant request can write. It is for the business name the workspace had at that moment: after a rename nothing is
sent until it is approved again. What to look at before approving: is it a real credit repair business, is the name its
own (the code refuses a name with a link in it; it cannot tell that "Wells Fargo Home Mortgage" is not theirs), and
where does its partner list come from. The Partners and Leads pages tell the agency plainly when it is waiting for this.

**When it stops.** An opt-out (at once, and for good: the database refuses to undo it, to change the address, or to add
that address to the agency's list again); staff recording a reply, "interested", "not interested" or a bounce; a manual
pause; and a message the email service refuses (that partner stops until someone presses "Try again", three attempts
at most). Two refusals in a row mean the sending side is probably broken, so the whole sequence then holds for 24
hours, or until someone presses "Try again" on one of them, and the owners and admins get an in-app notification with
the reason: a domain that is not verified stops two partners, not the list. A send whose result was never recorded is
never repeated.

**How a partner opts out.** The link in every email opens a page that asks "Stop emails from <agency>?" with one
button; pressing it is the opt-out, with no sign-in. Opening the page changes nothing, because mail security gateways
fetch the links in incoming mail: if a fetch were the opt-out, the first email would opt out every partner behind such
a gateway for good. Every email also carries `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
(RFC 8058), pointing at `POST /api/unsubscribe/partner/<token>`, so the "unsubscribe" button of a mail program does the
same. An opt-out goes on one list for the whole deployment, read by normalised address (lower case, without a "+tag",
and for Gmail without dots): an address that stopped these emails is not written to through another workspace or as
`dana+1@` either. Staff can still record that an opted-out partner replied or is interested (they may telephone); that
sends nothing and does not lift the stop.

**Bounces and complaints.** A reply goes to the agency's reply address; this app does not read that mailbox, so staff
record replies on the partner's page. Bounces and spam complaints can be reported by the email service: add a webhook
in Resend for `email.bounced` and `email.complained` pointing at `POST /api/webhooks/resend`, and put its signing
secret in `RESEND_WEBHOOK_SECRET` (the route answers 404 until then, and trusts a request only when its Svix signature
verifies; `src/lib/resend-webhook.ts`). A bounce stops that partner; a complaint opts the address out for good. With
three or more bounces since the workspace was approved, and more than one in ten of what was sent, the whole sequence
holds until the list is cleaned and the operator approves the workspace again. Without the webhook, staff press
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
  message that asks for a US mobile number. The area-code list is an allowlist written from the numbering plan as known
  in 2026; **it was not checked against NANPA's published list from the build environment**, so compare it with
  nationalnanpa.com before relying on it. A code missing from it only means that number gets no text. Guam, the Northern
  Marianas, American Samoa and the US Virgin Islands are not texted.
- **The person's own hours.** These are marketing texts, so they go out between 9:00 and 20:00 only, judged in the
  workspace's zone, in Eastern and Pacific, and in the zones of the state the number's area code belongs to. A text
  held for the night goes out with the 20:00 UTC run, which is inside that window in every US time zone.
- **Limits.** One text consent per number per agency; at most 40 lead texts per agency and
  `OUTREACH_PLATFORM_DAILY_TEXTS` (default 300) for the deployment in any 24 hours, counted under a lock when a text is
  claimed.
- **The business name.** It starts every text, so a name that carries a web address sends nothing.
- **Stopping.** STOP withdraws the consent for good. "Asked to stop" on a lead does the same (and ends the emails), so
  the consent cannot carry over if the lead becomes a client. Neither the public form nor staff can switch texts back
  on for such a number; only the person can, signed in to the portal. A consent staff switched off is not brought back
  by the form either.
- **Replies and delivery reports.** A reply goes to the record of the workspace that texted the number last, counts as
  "replied" and ends the automatic follow-up there. When that cannot be told (the same person agreed to texts from two
  workspaces and neither was texted more recently), each record is told that a reply arrived and texts to it pause, but
  the wording is shown to neither; the message itself is kept with no workspace and counted in the job's result. A
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
recently; if that still does not settle it, it is kept unmatched (Settings → Client updates). One sending number is
shared by all workspaces of a deployment, so a reply that matches clients in two workspaces equally belongs to neither
and is visible only in the database (`sms_inbound` where `org_id` is null); the scheduled job reports how many such
rows are unreviewed (`unmatchedInboundTexts`) and logs a warning.

### The Get set up page

Owners and admins can follow these steps in the app at `/app/setup` (linked from Settings → Integrations). It reads the
real configuration, names the environment variables still missing (names only, never values), shows the webhook
address to paste into Twilio and whether Twilio has reached it, and has "Send a test email to me" and "Send a test
text to me" buttons that show the provider's own answer. A step is ticked only when its check passes; A2P 10DLC
registration cannot be checked from the app and is never ticked.

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

8. Open Settings → Client updates. “Text messages: Connected” means the variables are present, not that Twilio accepted
   a message. Turn on one event, agree to texts as a test client with your own phone, trigger the event, and check the
   client's Messages tab. If you rotate the Auth Token, update `TWILIO_AUTH_TOKEN` at the same time or every webhook is
   refused (403).

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
- **Texts to anyone else without a recorded consent.** The only automatic texts go to a client who agreed in the portal (file updates) or a lead who ticked the text box on the enquiry form (follow-up), at the number that consent names, until they reply STOP.

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

## AI credits

AI wording is metered so the platform operator can charge for it. Nothing about AI is free.

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
  and portal layouts set `maxDuration = 60`, above the 30 s provider timeout; the host plan must allow 60 s functions.
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
  not reconciled against credits. Not exercised against a live AI provider — fake provider in tests only.
