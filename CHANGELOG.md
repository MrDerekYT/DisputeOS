# Changelog

## Review fixes for the client intake and the Claude connection (unreleased)

An independent review of the two entries below confirmed 31 defects; each fix was verified again by a second reviewer.
Migration `0031_client_intake.sql` was edited before release (new columns `signed_on`, `cancellation_ends_on`,
`revoked_reason` on `client_consents`, a client's own payment terms and total, and the functions
`app.cancel_own_contract()` and `app.client_signed_again()`). A development database that ran an earlier copy must run
it again by hand (`psql -v ON_ERROR_STOP=1 -f db/migrations/0031_client_intake.sql`; it is safe to run again) or be
rebuilt; production never ran it.

- **No service without a contract in force.** Recording a letter as sent now needs the same agreements as submitting a
  dispute, so a contract the client cancelled, or none, stops both. A sent date before the contract was signed, or
  inside its cancellation period, is refused with the dates named.
- **Personal workspaces** ("I am repairing my own credit") have no service agreement, no cancellation period, no
  2-year retention block, no Client agreement card and no Welcome link card; the person's own authorization for
  report imports is recorded as given by the account holder, and names the software and any report provider they
  connect, for their own reports (not their own workspace as if it were an agency).
- **Paper signatures** recorded by staff need the date written on the paper. The cancellation period runs from that
  date, and the stored text is labelled as the app's text when the paper was recorded, never as a copy of the paper.
  Staff can no longer record the electronic-records consent: only the client gives it, in the portal.
- **The last day to cancel is stored when the contract is signed**, so a later time-zone change cannot shorten it.
  The evidence pack and the charge check use the agency's own day.
- **When a client cancels in the portal**, they see "You cancelled your service agreement on <date>" instead of a
  request to sign again; the client is marked cancelled and the owners, admins and their specialist are notified.
  Signing a new agreement later makes them active again and tells the team.
- **Existing clients**: those who signed the January 2026 draft documents are flagged on their page with what to do;
  a re-papered client signs the current statement before the new contract; a missing electronic-records consent no
  longer tells an active client that work cannot start, and the investigation stays on their portal home.
- **Each client can have their own payment terms and total**, set by staff before the client signs, for agencies
  with more than one plan.
- **The terms check** refuses promises of removal (including ones that name the bureaus, accounts, bills, loans or
  inquiries) and payment asked for at signing, on the effective date, at the start of the month for that month's work,
  or before the work starts; how the agency deletes its own records and honest cancellation terms ("if you cancel
  before the first letters, you pay nothing") pass.
- **Federal holidays** are computed by rule for any year, so dates after 2030 still skip them.
- **Signed copies** say when a character could not be printed in the PDF, and the fingerprint is of the stored text.
- **Dates of birth** that do not exist (February 31) are refused, and a stored impossible date prints as needed.
- **Welcome links**: changing a client's email ends their unused links, a link works only while its email matches
  the client's, and the card shows the email the portal account uses. The timeline says a welcome email was sent only
  after the email service accepted it. An email that already has a portal with another company gets a plain message.
- **Portal**: an agreement that changed while open is shown again with a note; no loops while the agency's terms are
  not ready (and no promise of a notification); the credit guide's steps come from the same records as the portal home.
- **AI**: one attempt may use the whole 45 s, the monthly spending limit has its own message, the progress note's two
  courtesy sentences may only use courtesy words, and the credit guide masks and refuses more (see the entry below).

## Client welcome link, guided intake and the agreements (unreleased)

Migration `0031_client_intake.sql`: additive and safe to run again.

- **Welcome link.** On each client's page, a "Welcome link" card replaces the "Invite to client portal" button. Staff can copy a fresh one-time link, or email it when email really delivers. The email is in the client's language, from the agency's name, with replies going to the agency's address. It is checked for prohibited claims and held to the workspace's hourly limit until the operator approves the workspace. A new link ends the client's earlier unused links, with at most 10 a day per client. The card shows the state: no email, not invited, link sent and when it expires, joined with progress (details, agreements n of 4, ID documents n of 3), finished. Leads have a "Welcome link" action next to "Convert to client".
- **Invitation page.** It shows the agency's brand, "Welcome, <first>!", the four steps ("about 10 minutes; have your photo ID and a recent bill handy"), an English/Spanish switch, and asks for the password twice. The language chosen becomes the client's. A used, expired or replaced link shows a kind message in the client's language and a button to the agency's own sign-in. Accepting opens the guided welcome.
- **Guided welcome (/portal/welcome).** A focused page with a progress bar and "Finish later":
  - Your details: name and email are read-only. Date of birth and SSN are written once and never shown back.
  - Your agreements: one per screen, full text, typed name and a checkbox, then a PDF copy.
  - Your ID documents: one upload per item. Phone photos are made smaller in the browser to fit the upload limit. "I'll do this later" is allowed.
  - Done: "Welcome to the family", the specialist, the last day before anything goes to the credit bureaus, the signed copies, and "Cancel my agreement" while the period runs.
  The step comes from the client's records; the portal home, Profile and the staff card use the same helper. All new portal text is in English and Spanish.
- **Client agreement (Settings).** Owners and admins save the agency's terms: legal name, principal business address, a full description of the services, payment terms, the total of all payments, how long the services should take, and optional additional terms. Every field is checked on the server against a list of common promises of results and of payment before the work is done (a rule list: it catches the usual wordings, it does not make a contract lawful). Changes are audited.
- **The agreements.**
  - The server enforces the signing order in the portal: consent to electronic records, then "Consumer Credit File Rights Under State and Federal Law", then the service agreement, then the authorization.
  - The consent to electronic records is rewritten with the disclosures of 15 U.S.C. § 7001(c)(1). The client confirms they can read the page and opened its PDF copy.
  - The § 1679c statement is word for word and is its own document.
  - The service agreement is built from the agency's terms with fixed parts: the parties, the date, a no-guarantee paragraph, no payment before the service is performed, the § 1679d(b)(4) statement in bold above the signature, and the § 1679e(b) Notice of Cancellation in bold with the agency's name, address and last day filled in.
  - The authorization names the agency.
  - The service agreement cannot be signed until the terms are saved.
- **What is recorded.** Every new signature stores the exact text shown, its full SHA-256 (checked by the database) and the page language. A paper signature also records the staff member who recorded it. The signing page posts the hash of what it displayed, and a text that changed is refused.
- **Copies.** /api/consents/<id>/pdf prints the stored text and the signature block. For the contract, the Notice of Cancellation is printed twice, each on its own page, and the statement and notice are in bold. Letters print exactly as before.
- **The cancellation period** now runs through the 3rd business day on the agency's own day, with weekends and federal holidays skipped; it used to end a day early. While it runs, no dispute can be recorded as submitted and no letter recorded as sent. The client can cancel from the portal: their written notice goes to their specialist and the agreement is revoked.
- **Retention.** A client whose signed statement is less than 2 years old cannot be deleted. Mark them cancelled instead.

**Changed:**

- The consent to electronic records is now required and comes first. Disputes still need only the statement, the contract and the authorization, so a paper signature or a withdrawn e-consent does not stop the service.
- Staff recording paper signatures keep the statement → contract → authorization order, and the contract needs saved terms.
- The browser scripts now save the client agreement terms first. They check that a submission inside the cancellation period is refused, then date the test signatures back in the database the server uses (E2E_DATABASE_URL, or DATABASE_URL).

## Claude through the official SDK, a Setup connection test, and a live proof (unreleased)

No migration. New dependency: `@anthropic-ai/sdk` 1.5.0, pinned (a release from 4 November 2026). The Claude connection is built to the current Anthropic API. It is proven live only once `npm run ai:prove` has passed with a real key; until then it has been tested against a mocked API and a local stand-in only.

- **The Anthropic adapter uses the official SDK** (`src/lib/ai/provider.ts`).
  - Default model `claude-opus-5-5` (was `claude-sonnet-5-5`). `AI_MODEL` overrides it; cheaper choices are `claude-sonnet-5-5` ($2 / $10 per million input / output tokens) and `claude-haiku-5-5` ($0.10 / $0.50), against $4 / $20 for Opus 5.5.
  - New `AI_EFFORT` (low, the default, medium or high), sent as `output_config.effort`.
  - `max_tokens` 16000 by default, because the model's thinking counts toward it. No sampling or thinking parameters.
  - Server-side refusal fallback is on (`server-side-fallback-2026-07-01`, `fallbacks: "default"`).
  - Only text after the last fallback block is read. A refusal, a reply cut off at `max_tokens`, or any stop other than `end_turn` is "AI unavailable", and the credits are given back.
- **Time limits:** one attempt may use the whole 45 s deadline; a fast failure (429, 5xx or a dropped connection) is retried once within it, honouring `retry-after`. The layouts' 60 s `maxDuration` still leaves time to settle the credits.
- **Errors** are read from the SDK's typed errors and shown in plain words: "the AI key was refused", "the AI service is busy, try again in a minute", "the AI model … was not found", "the AI account has reached its monthly spending limit" (not retried), "HTTP <status>".
- **One log line per call:** `[ai] anthropic model=… stop=… in=… out=… ms=… request=req_…`, with the API's structured error `code=` on a failure. It never includes the prompt, the reply or the key. `ANTHROPIC_LOG=debug` and trace-span content settings cannot override this.
- **Progress note polish no longer sends the client's first name.** The greeting now sits on its own line in the drafted note and is locked; only the connective sentences are sent. A reply is discarded if it:
  - changes the lines or adds wording around a protected passage,
  - adds or drops a sentence,
  - adds formatting,
  - rewords its two courtesy sentences with any word outside a fixed list of courtesy words (English and Spanish), so a promise cannot be slipped in.

  The four replies an earlier probe saw accepted (a Spanish removal promise, a vague promise, an echoed `<source>` tag, a preface) are now rejected.
- **Credit guide:** the 400-token cap is gone. Questions now also have masked: dates (a date of birth in any common form), city-state-ZIP lines, unit numbers, SSNs written in 3-2-4 groups, more street forms, and the address, ZIP, SSN last four and date of birth the app holds for that client. An answer is refused when a sentence pairs a word of likelihood or of what usually happens with a result (a score change, a removal, an approval).
- **Get set up → "Test the AI connection"** (owners and admins):
  - One fixed, tiny request with no client data. It is free.
  - Limited to 5 an hour per person, 10 per workspace and 100 a day for the deployment, and audited as `setup.test_ai`.
  - A pass records when it passed and with which model. The AI step is done only after a pass with the model in use now.
  - A provider chosen without its key is a step to do, and Settings → Integrations shows "Needs credentials".
- **Wording:** the AI assistant page, the marketing features and security pages and docs/SECURITY_AND_COMPLIANCE.md now say exactly what is sent and what is masked.
- **Live proof:** `npm run ai:prove` runs `tests/live/ai.live.test.ts`, which is skipped unless `AI_LIVE=1`.
  - It makes one real call per AI feature on a synthetic client and runs the Setup test.
  - It prints each request, the raw reply, the stop reason, tokens, time and request id.
  - It fails if any of that client's personal data appears in a request.
  - The same privacy check runs offline on every test run (`tests/unit/ai-no-pii.test.ts`).
- **Docs:** docs/INTEGRATIONS.md ("AI provider (Claude)"), docs/DEPLOY-VERCEL.md ("8. Connect AI (optional) and grant AI credits"), .env.example, README.md.

## Review fixes, third round: letters, disputes and outreach (unreleased)

Migration `0030_partner_opt_outs.sql`: additive, safe to run again, needs no superuser. A development database that ran
an earlier copy of `0028_partner_outreach.sql` has to run that file again by hand (`psql -v ON_ERROR_STOP=1 -f ...`) or
be rebuilt (`npm run db:reset`); production never ran it.

- **Debt validation letters use only the notice recorded for that debt.** A notice recorded by the collector's name
  alone is no longer used when the client has another collection account with that collector; the letter then asks
  without citing Section 809(b), and the recommendation says to link the notice to the account.
- **A letter is checked again when it is sent for approval and when it is approved**: a recorded response, a
  collector's 30 days that have ended, a document no longer accepted, or the client confirming the item is accurate
  stops it, with what changed and "Draft the letter again". Recording that a letter was mailed is not re-checked.
- **Recording an outcome needs the date the response was received** (except "No response", which has its own
  button), and recording an agency's "frivolous or irrelevant" notice needs the date of the notice. Neither can be in
  the future or before the dispute was sent, and an impossible date such as February 30 is refused with a plain
  message. Letters no longer print a receipt date nobody entered, and "No response" is no longer shown as a day a
  response arrived.
- **An "Item may be past the reporting period" dispute** gets the outdated-item letter unless staff pick another by
  name, so an item still inside its period is refused with the reason instead of drafted as a general dispute.
- **Wording**: the follow-up's subject reads "Status of the dispute I sent on <date>"; the goodwill request opens "To
  whom it may concern:"; "Other" is no longer printed among the information to review; a later round of a letter to a
  creditor or collector speaks of "your reply", not of a bureau's results; a debt validation request is titled without
  the statute, and when it cites Section 809(b) the citation sits on the dispute sentence and the list starts "Please
  include:"; a specialty agency's name is no longer printed twice when staff paste its address.
- **The reason check**: a reason that plainly says what is disputed ("The judgment was vacated on May 12, 2021") is no
  longer held for not using a listed word; an empty or bare reason still is.
- **Outreach**, **the mailing address**, **the portal's text card** and **emails the service did not answer**: see the
  section below, which now describes the final behaviour.

## Referral partners, text follow-up, and the operator's approval for outreach (unreleased)

Migration `0028_partner_outreach.sql`: additive and safe to run again. Four new tables (`partners`, `partner_outreach`,
`partner_events`, `partner_referrals`), two columns on `organizations` for the operator's approval, one more source for
an SMS consent (`enquiry_form`) and two text steps in the lead follow-up log. Nothing is on until an owner or admin
switches it on, and nothing automatic leaves a workspace until the platform operator has approved it. Details:
docs/INTEGRATIONS.md, "Referral partners and lead text follow-up".

- **Operator approval** (`src/lib/outreach-approval.ts`; `npm run outreach:approve -- <workspace-slug>`, or the SQL in
  docs/DEPLOY-VERCEL.md section 7). Sign-up is open, the enquiry form takes any address and any number, and every
  workspace sends through the deployment's one email service and one text number. So the follow-up emails and texts to
  leads, the partner emails, client updates by text and the test text are sent only for a workspace the operator has
  approved, under the business name it had then; a rename ends the approval. The command prints the mailing address and
  the reply address the workspace saved before it approves. The Leads, Partners, Setup and Settings pages and the
  client page say when a workspace is waiting for it. **This changes a feature that is already live: lead follow-up
  emails stop for a workspace until the operator approves it.** Emails to a workspace's own team and clients
  (invitations, sign-in emails, client updates by email) do not need the approval.
- **Partners** (`/app/partners`, under Business; agencies only). Businesses that can refer clients, added by the agency
  itself: one at a time or as a pasted or uploaded list (up to 200 rows; invalid rows are named and left out). One
  mailbox is one partner: an address that differs from one already listed only by a "+tag" (or, for Gmail, by dots) is
  skipped. Whoever adds them confirms the contacts came from public business contact details or the agency's own
  contacts; the sentence they ticked and who ticked it are kept. Counts, search, status filter, and a page per partner
  with the emails as sent and a timeline. Nothing is scraped, bought or looked up.
- **Automatic email sequence** (`src/lib/partner-outreach.ts`): introduction, follow-up after 4 business days, last note
  9 business days after the introduction, sent by the scheduled job with no approval of each message. Needs the
  operator's approval, the switch on, email connected, and the postal and reply addresses the lead follow-up uses.
  Business days only; at most 10 per run and 40 per agency in any 24 hours (10 a day for the first 14 days after
  approval), and a limit for the whole deployment (`OUTREACH_PLATFORM_DAILY_EMAILS`, default 500); each (partner, step)
  once even when runs overlap. Stops on an opt-out, a recorded reply, "interested", "not interested", a bounce or a
  pause. A message the email service refuses stops that partner, and two refusals in a row hold the whole sequence for
  24 hours (or until "Try again") and notify the owners and admins. An email the service gives no answer for is shown
  as "Not confirmed as sent" and is never sent a second time. Too many bounces hold the sequence until the operator
  approves the workspace again. Where a partner stands in the sequence is written by the scheduled job only.
- **Opt-outs.** Every email carries an opt-out link that opens a page with one button (opening the page changes
  nothing, because mail scanners open links), and the one-click unsubscribe headers mail programs act on. An opt-out is
  permanent for that address in that agency; the database refuses to undo it. An opt-out the recipient made (the link,
  the mail program's button, a spam complaint) also goes on one list for the whole deployment (migration
  `0030_partner_opt_outs.sql`), so no workspace emails that mailbox again, in any spelling; in another workspace the
  partner is paused, with the reason on its timeline. The list belongs to no workspace or user, survives deleting
  either, and no signed-in person can read or change it. "Asked to stop" pressed by staff stops that workspace's own
  emails only, so one workspace cannot switch off another's by listing its addresses; the recipient's own opt-out still
  counts afterwards, and the page behind the link still offers its button.
- **Bounces and spam complaints** reach the app through a signed Resend webhook (`/api/webhooks/resend`,
  `RESEND_WEBHOOK_SECRET`); without it staff press "Bounced". The same webhook ends all automatic follow-up to a lead
  whose follow-up email bounced or was marked as spam, and the Leads page says which it was. Partner emails can use their own sending address and key
  (`OUTREACH_EMAIL_FROM`, `OUTREACH_RESEND_API_KEY`), so they do not share a sending reputation with sign-in emails.
- **Wording** (`src/lib/partner-emails.ts`): fixed, in English and Spanish, per category, saying what the agency does
  and that no result, score or approval can be promised. Each email says it is a business solicitation and shows the
  agency's name and postal address. No AI writes or rewords any part of it. The emails as they will leave (with the
  agency's name, website address and mailing address in them) are checked against the claims guard before anything is
  claimed, and the Partners page names what is in the way. A city whose name reads as a claim is refused when the
  partner is added.
- **The mailing address** printed in automatic emails (`src/lib/mailing-address.ts`) has to be shaped like a US postal
  address: from the street number or a box (PO Box, PMB, rural route, suite, the Puerto Rico forms) to the state and the
  ZIP code, with no web address, no phone number, nothing the claims check refuses, and only a few words between
  commas. It is checked when it is saved and again when it is read: a value saved earlier that does not pass counts as
  no address, and the Leads and Partners pages show it with what is wrong so it can be corrected.
- **Replies and referrals.** Replies go to the agency's own mailbox, so staff record them: "They replied",
  "Interested", "Not interested", "Bounced". A client can be marked as referred by a partner (client page), and each
  partner shows how many.
- **Text follow-up for leads** (`src/lib/lead-texts.ts`, `runLeadTexts` in `src/lib/lead-outreach.ts`). Off by default,
  own switch on the Leads page. When it is on, the workspace is approved and a text service is connected, the enquiry
  forms show a second, unticked, separately worded box; ticking it records an SMS consent (wording, number, time, IP).
  Only such a lead gets a welcome text and one follow-up three days later, at a US mobile number, between 9 a.m. and
  8 p.m. where they are; everyone else gets email only. At most 40 lead texts per agency in any 24 hours and a limit
  for the whole deployment (`OUTREACH_PLATFORM_DAILY_TEXTS`, default 300). STOP applies, the public form cannot switch
  texts back on for a number that replied STOP, and the same form sent several times at once records one consent. A
  business name that contains a web address sends no lead texts.
- **Lead follow-up emails** (already live): besides the approval above, an email the service gives no answer for (a
  timeout, a dropped connection, or an HTTP 5xx) is no longer tried again: it could have arrived, and a second copy
  would follow. The switch, the approval and both addresses are read again with every email, and the follow-up texts
  read them again with every text.
- **Emails staff send by hand** ("Invite to client portal", an email from the Messages tab, "New client" with the
  invitation ticked): until the operator approves the workspace, at most 50 an hour for the whole workspace. When the
  email service does not answer, the screens say the email may or may not have arrived instead of "failed", and so do
  the test email on the Get set up page and a client update by email. The invitation greets the client by first name
  only when it reads as a name.
- **Client updates by text** (already live): sent to US mobile numbers only, and only for an approved workspace. A STOP
  reply ends every consent for that number however many client records carry it, and a workspace cannot pull another
  client's reply to itself by typing the number onto records of its own. The test text on the Setup page follows the
  same rules and no longer carries the workspace name.
- **Scheduled job**: runs at 09:00 and 20:00 UTC (`vercel.json`). Every workspace's own work comes first and the
  outreach after it, each with a deadline; what is left goes out with the next run, the workspaces that waited longest
  first, and the run's result says what was not reached (`notReached`, `unfinished`) and how many email runs stopped
  because the email service did not answer (`unanswered`).
- **Public enquiry form**: the limit for one address is applied before the agency's hourly limit is counted, so one
  address posting over and over cannot close an agency's form for everyone else.
- **Not built, on purpose**: calls of any kind, auto-dialling, voicemail drops, and texts to partners.
- **Not verified**: nothing here has been sent through the live Resend or Twilio services, and the Resend webhook has
  not received a real event; tests use stand-ins for both.

## Letters tailored to each client's file (unreleased)

No migration. The setting lives in `organizations.settings.letter_auto_tailor`; everything else reads existing tables.

- **Letter brief** (`src/lib/letters/brief.ts`, pure; rows read by `brief-load.ts`): one place assembles what a letter
  is built from, from the client's own record: the recipient, the account as that bureau reports it, what is disputed
  and why, the earlier round and what came back, the documents enclosed, and recorded circumstances (bankruptcy, an
  identity theft report, a collector's notice date). `createLetter` drafts from it. A debt validation letter uses only
  the collector notice recorded for that debt, never the notice of another debt the same collector holds.
- **Optional paragraphs, each only when the fact is on file.** A line restating the reported values in dispute ("As it
  appears on my Experian credit report dated ...", from an approved report of that bureau only), a paragraph on the
  earlier round (only when one was sent) and its recorded result, a sentence naming the evidence attached and the
  identity documents accepted (and nothing when there are none), and the collector's notice date on a validation
  request while its 30-day period is open. Two short lines of connective wording (a linking sentence and a closing
  courtesy) are picked by a style seed worked out from the client's id, so one client's letters keep one voice and
  another client's read differently. Merge fields for an agency's own templates: `reported_text`, `history_text`,
  `enclosed_text`, `notice_text`, `lead_in`, `courtesy`, `outdated_subject`, `outdated_what`, `outdated_period`.
  Templates without them are unchanged.
- **Recommended letter.** A dispute's page shows the letter that fits it with a one-line reason from the file and a
  "Draft this letter" button, until a letter of that kind exists or the dispute is sent. The new-letter page preselects
  and marks the same letter and says why; after sending it follows the record (nothing while the period runs, the
  follow-up once it has ended with no response recorded, the method of verification after "verified"). The new-dispute
  page names the letter the dispute will start with. No AI; staff can always choose another letter that fits the
  dispute, and nothing is offered for an item the client confirmed as accurate.
- **Drafted reasons** (`src/lib/disputes/reasons.ts`). The new-dispute form drafts a reason only from what is on file:
  a difference between two bureaus (one value per bureau, from each bureau's newest approved report), the entries a
  finding lists, the reported date of first delinquency, or the client's own recorded statement. A reason that only
  asks for something to be verified is held at approval until a person adds what the client's records show, and the
  form says so. Nothing is pre-filled for a payment-history dispute, an inquiry the client does not recognize, or a
  request to the creditor to check what it reports: a person writes the client's own words. Dates are written out
  ("March 5, 2018"), the date in question is named, and the date of first delinquency is mentioned only when the
  evidence is about it. A duplicate is asked about so that the debt is "not reported as owed twice" (a collector and the
  original creditor may both report it correctly). No drafted reason asks for a removal. "Client says payments were never
  late" starts a payment-history dispute, not a "Not my account" one, and a dispute drafted in bulk from a finding is
  about the finding's own first account.
- **One first-round dispute of a kind per account and bureau.** A second one is refused while the first is open or
  after it was resolved without a change, and the message points to starting the next round from the earlier dispute.
  A different issue with the same account, the same issue with another bureau, and an item that was deleted or
  corrected and came back can still be started. The same holds for an item with a specialty agency (ChexSystems, Early
  Warning and the like). The next round of a dispute about an account typed by staff keeps the account's name and
  digits.
- **AI wording is tailoring** (`src/lib/letters/tailor.ts`, on top of the unchanged protected rewriting). "Suggest
  better wording" may reword only the linking sentence and the closing lines, and may exchange the salutation and the
  sign-off for another from a short fixed list. Every other line is locked by where it stands in the letter and is
  never sent to the model: the client's name and address, the recipient, the account, every sentence of the reason (one
  typed by hand included), every reported value, every request and every enclosure line. A reworded line has to be
  plain English words from a short list of courtesy words. It cannot add a sentence, a name, a number, an address, a
  statement about earlier contact, or more "I" and "my" than the line had. The same checks run on the model's result,
  again when a person accepts a suggestion, and in the automatic step; a result that fails any of them is discarded
  and nothing is charged. Same price as before (`letter_suggestion`, 5 credits), charged once per letter version, also
  when two people ask at the same moment. A letter that already fails the specificity check, or has nothing to reword,
  is not sent to the model at all. Restoring an AI-worded version keeps its "AI wording, not yet approved" mark.
- **Wording overlap.** A letter in draft or awaiting approval shows "Wording overlap with other recent letters: Low /
  Medium / High": a word-shingle comparison of the whole letter, from the "Re:" line to the sign-off, with up to 30
  letters for other clients from the last 180 days, done on the server from stored text. Names, numbers, dates, bureau
  names, the reason and list lines are left out, so what is compared is the standard wording. No AI and nothing is sent
  anywhere.
- **One optional setting**, AI assistant page, owners and admins: "Tailor wording automatically when a letter is
  drafted". Off by default. On, each drafted letter goes through the same tailoring once (same checks, same charge) and
  a safe result is saved as a new draft version marked "AI wording". The letter is still a draft that a person reads
  and a manager approves; nothing about approval or sending changed.
- **Not done.** The checks on reworded lines are a word list and patterns, not a proof: a person still reads and
  approves every letter, and the screens say so. Letters drafted before these checks existed are not checked again
  when they are approved. The AI path is tested against a fake provider only; no live provider was called, so how
  often a real model's result passes the word list is not known. The new screens were type-checked, linted, rendered
  in tests and opened in a browser against demo data; the AI screens were opened with no provider connected.

## English letter library, personal information corrections, bank-account guide (unreleased)

- **Letters are English only.** The Spanish letter templates and the language switch on letters are gone: a client's
  preferred language no longer selects a letter language. The portal, texts and emails keep their languages. Letters
  already stored are untouched (a stored Spanish letter keeps its text and its `language = 'es'`). An agency's own
  template marked Spanish is not drafted from until it has been put into English and a manager marks it so.
- **Letter library** (`src/lib/letters/library.ts`, templates in `src/lib/letters/templates.ts`): one letter per
  situation with the same heading, reference line, enclosure list and signature. To a bureau: general dispute, not my
  account, inaccurate balance, inaccurate payment history or dates, inaccurate account status, duplicate account,
  outdated item, account included in bankruptcy, identity theft block request, personal information correction,
  re-dispute with new information, follow-up with no response recorded, method of verification. To a collector: debt
  validation, stop communication. To the creditor: letter to the creditor (asks it to check its records and cites no
  statute), goodwill request, request to update a paid account (an accurate update; "pay for delete" is not offered).
  To a specialty agency: the account-record dispute. The new-letter page shows them as a picker grouped by recipient
  with a one-line "use when"; letters that do not fit the linked dispute are folded away. A letter cites a statute only
  where its request rests on one.
- **Letters follow the file.** A dispute's default letter is now the one written for its category. A situation letter
  is refused, not padded, when a fact it rests on is not on file: an identity theft block without an accepted identity
  theft report (FTC or police) and an accepted photo ID in the client's documents, a re-dispute with nothing new or
  without a recorded "verified" result, an outdated letter when the reported date of first delinquency does not put
  the item past its reporting period, a bankruptcy letter with no bankruptcy recorded, a follow-up before the period
  has ended or after a response was recorded, a debt validation letter that would cite the 30-day right with no open
  collector notice on file for that debt.
- **A letter that states the client's position is drafted only for a dispute entered with that position.** "Not my
  account", "Duplicate account", "Account included in bankruptcy", "Request to update a paid account", "Inaccurate
  balance", "Inaccurate account status" and "Inaccurate payment history or dates" are greyed out for any other dispute
  type (an "Other" dispute with the matching field ticked counts), and the message says which type to start. The same gates hold an agency's own copy
  of a letter, and an own template that still cites a right the built-in letters do not claim (Section 623(a)(8), or
  Section 809(b) with no open notice) is not drafted from.
- **Outdated item, for an account that is only late**: the letter is about the late payment information that appears
  to be past its reporting period, not about the account, which keeps being reported.
- **Identification on letters.** A bureau letter carries the client's date of birth and, unless the box is unticked,
  the last four digits of the SSN; what is not on the client's record is a marked line a person completes before
  approval. The letters written for a debt collector never carry the SSN digits. A letter to a specialty agency, its
  follow-up included, carries the identification lines that agency asks for instead.
- **New dispute form.** A bureau dispute about an account that is on no imported report has to name the account (for
  an inquiry, the company that made it).
- **Three dispute types added**: account included in bankruptcy, identity theft block request, paid account (request
  to update).
- **Personal information on reports** (client record, Reports tab; portal Profile page in English and Spanish): staff
  or the client mark names, addresses, employers, phone numbers or a date of birth on one bureau's report as wrong or
  not theirs. Names, addresses and employers are offered to staff from the imported report; everything else is typed.
  One button drafts the correction letter for a bureau as an ordinary dispute with a draft letter, with the identity
  enclosures list. Migration 0026 (`personal_info_marks`, additive).
- **Bank account sent to collections** (client record, Reports tab): a few plain questions about an overdrawn or
  closed bank account, and the steps that follow, each linking to an existing tool. Only details the client says are
  inaccurate are disputed; when the client says the record is accurate it says so and offers only the paid-account
  update, the goodwill request and the consumer statement. No retention period is stated for ChexSystems or Early
  Warning because none has been confirmed at its source (`Agency.recordRetention` is there for when one is).
  Migration 0026 (`bank_collection_cases`, additive, staff only). Nothing is drafted or sent automatically.

## Review fixes for setup, custom domains and case tools (unreleased)

- **Test text**: sent to US mobile numbers only, only for a workspace the operator has approved, never to a number
  that replied STOP, and without the workspace name in it. Capped per workspace (3 a day) and for the whole deployment
  (50 a day) as well as per person. Test email is also capped per workspace (10 an hour).
- **Client sign-in on an agency's domain**: two-step verification (`/mfa`, `/mfa/setup`) and the password reset
  request now stay on the agency's host instead of bouncing to the platform host, where the client has no session.
- **Host rules apply to link prefetches** too (the middleware used to skip them).
- **Enquiry form on an agency's domain**: the thank-you page is opened by the browser rather than by a server-side
  redirect, which showed "page not found" under `next start` although the enquiry had been saved.
- **A domain is connected only for the workspace that controls it**: besides the hosting provider's own DNS records,
  the Website page shows one TXT record (`_disputeos.<domain>`) whose value is different for every workspace and
  domain. "Check now", "Connect domain" and the operator's `npm run domain:verify` mark a domain connected only when
  that record is in the domain's DNS, so DNS records created for one workspace no longer verify the domain for another
  workspace that enters the same name. A domain that is already connected stays connected. `domain:verify` needs
  `PII_ENCRYPTION_KEY` in its environment and names the workspace it is checking for.
- **Unverified domain claims no longer lock a name**: a claim that is more than a day old and never verified gives
  way to the next workspace (and is removed from the hosting project if the app added it). A verified claim, or one
  made in the last day, stands; a workspace whose TXT record is already in place does not have to wait the day.
  Connect attempts are capped at 10 a day per workspace.
- **Redirect from an agency's domain**: a path that starts with two slashes is sent to the platform's own host like
  any other path, and can no longer point at another site.
- **Portal guard** (migration `0029_portal_guard_bankruptcy.sql`, additive, safe to run again): a portal client can
  still change their own phone, address and language, and the database now also refuses a change to the bankruptcy
  chapter and dates on their record, which staff enter.
- **Personal information in the portal**: marking an entry the team already listed no longer answers "Saved". It says
  the team already listed it and keeps what the client typed.
- **HSTS**: `includeSubDomains; preload` is sent only on the platform's own host; agency domains get plain `max-age`.
- **Validation period wording**: what counts is the day the consumer sends the written request (12 CFR 1006.38(c),
  (d)(2): "submitted ... within the validation period"), not the day the collector receives it. EN and ES updated.
- **Dashboard setup reminder** counts only what the workspace can do itself (its mailing address, reply address,
  time zone, and its own test once the provider is connected), not the host's environment settings.

## Case tools: collector validation clock, medical collection screen, bankruptcy audit (unreleased)

- **Collector validation period** (client record, Reports tab, "Collections and bankruptcy"): staff record a debt
  collector's notice (received date, or sent date with receipt presumed 5 days later, not counting Saturdays, Sundays
  and legal public holidays, 12 CFR 1006.34(b)(5)). The page shows the end of the 30-day period and days left, apart
  from the credit-report dispute clock. While it is open it links to the existing validation request letter to the
  collector (drafted, reviewed and approved like any letter); after it, a plain note on what the end generally means.
  The client sees the date and an explanation in the portal (EN/ES). Migration 0025 (`collector_notices`, additive).
- **Medical collection screen**: collections the report describes as medical, or that staff tick as medical, and that
  are paid, under $500 or under one year old get a "worth checking" finding. It says this is the three bureaus' own
  policy (joint statements of March 18, 2022 and April 11, 2023), not law, and that the CFPB rule was vacated on
  July 11, 2025.
- **Bankruptcy discharge audit**: staff enter chapter, filing date and discharge date (three nullable columns on
  `clients`). Accounts dated before the filing are listed per bureau with what is worth checking: a balance, a status
  with no mention of the bankruptcy, a first delinquency dated after the filing. Shows how long the bankruptcy itself
  is generally reportable (10 years by statute; 7 years for Chapter 13 by Experian's and TransUnion's own policy).
- Findings from all three join the ordinary findings list (`generated_by = 'case_tools'`, created once, retired when
  they stop applying, never recreated after a person dismisses them); an open validation period is a step in the
  client plan. Credit guide: new "medical collections" entry, and the debt validation and bankruptcy entries updated.

## Agency custom domains (unreleased)

- **An agency can use its own domain** for its website (`/`), enquiry form (`/start`) and client sign-in
  (`/portal/login`). The `/a/<workspace>` address keeps working. Staff routes on an agency's domain redirect to the
  platform host. Migration 0023 (`agency_domains`, one domain per agency, additive).
- **Connect, check, remove** on the Website page (settings:manage). With `VERCEL_API_TOKEN` and `VERCEL_PROJECT_ID`
  the app adds the domain to the Vercel project and shows the DNS records Vercel asks for; without them the page says
  the platform operator must add it, and `npm run domain:verify -- <domain>` confirms it.
- **Never verified without evidence**: only Vercel reporting the domain verified and correctly configured, or the
  operator's check, marks a domain connected. Tenant requests can read their row and cannot write it.
- Canonical and Open Graph addresses use a site's verified domain, which serves its own `/sitemap.xml` and `/robots.txt`.
- **Not built:** buying a domain, sending email from the agency's domain, automatic handling of the www/apex twin.
  The Vercel API calls are tested against a mocked API only. Docs: docs/DEPLOY-VERCEL.md.

## Get set up page (unreleased)

- **`/app/setup`** (owners and admins): an ordered checklist for email, text messages and agency basics, built from the
  real configuration by a pure function (`src/lib/setup/checklist.ts`). It shows environment variable names and
  present/missing only: no secret and no value reaches the browser, except the Twilio webhook address built from APP_URL.
- **Nothing is ticked on configuration alone.** Email is done once Resend has accepted a test email; the webhook step is
  done once something from Twilio has reached the webhook. A2P 10DLC registration cannot be checked from the app and is
  never ticked.
- **"Send a test email to me" / "Send a test text to me"** (`src/lib/setup/test-send.ts`): need settings:manage, 5 emails
  an hour and 3 texts a day per person, go only to the signed-in person, show the provider's own answer, and write no
  communication, queue row or consent. An accepted test stores a timestamp in `organizations.settings`; a refused one removes it.
- Linked from the dashboard (one line, only while a step is left) and from Settings → Integrations. No migration.

## Review fixes to the five new features (unreleased)

Twelve reviewer findings on client updates, the dispute clock, the charge check and fall-off dates; all twelve were
real. Migrations 0018, 0019 and 0020 (none of them deployed yet) were edited in place and stay additive and safe to
run again.

- **Confirmed accurate means closed** (15 U.S.C. 1679b(a)(1)). Ticking "the client has confirmed this item is reported
  accurately" now also refuses another round and any new letter for that dispute, in the service and on the page.
  Before, the page still offered "Start round N+1".
- **Stop words** (47 CFR 64.1200(a)(10)). A reply containing stop, quit, end, revoke, cancel, unsubscribe or "opt out"
  anywhere, or a plain refusal ("no more texts", "no más mensajes"), revokes consent. This errs towards stopping. Any
  other reply pauses texts to that client until staff have read it on the client's profile.
- **A STOP is the client's to undo.** Staff can no longer record a consent over a STOP reply: refused in the app, the
  form is hidden, and a trigger on `sms_consents` refuses it for every connection (0018).
- **Quiet hours where the client is.** A workspace has its own time zone (Settings → Client updates), and a text is
  held unless it is 8 a.m. to 9 p.m. there and in every time zone of the state on the client's address; with no state
  on file, Eastern and Pacific both apply.
- **Replies cannot be pulled away by another workspace.** A reply goes to the client whose consent is in force for the
  number, then to the one texted most recently. What stays ambiguous is counted in the scheduled job's result.
- **"No response recorded" waits for the mail.** The no-response steps, the complaint summary and the client message
  start after the period end + 5 business days (15 U.S.C. 1681i(a)(6)(A)) + 7 days, not the day after the period ends.
- **Dates are the agency's days, not UTC days.** The legal clock, the 30/45-day check, the complaint summary and the
  dates written into letters no longer run a day ahead for anything recorded on a US evening; a letter's "I sent you a
  dispute on" uses the sent date staff recorded.
- **Citations and scope.** A 45-day period ticked at submission cites 15 U.S.C. 1681j(a)(3), not 1681i(a)(1)(B). A
  direct dispute with the furnisher is offered only for a dispute about an account on a report (12 CFR 1022.43(b)(1)).
- **Charge check.** The badge reads "No hold found" (it described the record, not the law). "Sold by phone" is now a
  three-way answer and starts unanswered (`clients.sold_by_phone` is nullable); until answered, the check says the
  phone-sale rule (16 CFR 310.4(a)(2)) was not considered.
- **Fall-off dates.** For an account that is only late, the line reads "Late-payment information from <date> is
  generally reportable until ...": the account itself keeps being reported.
- **Letters drafted before this release** are not held to the new specificity check (`letters.checks_version`, null on
  existing rows, 0019). A template of your own without `{{enclosures}}` gets the enclosures section added at the end.
  **If you have custom bureau templates:** new letters from them are still checked for the account number and a
  concrete reason; add `{{account_text}}` and `{{enclosures}}` where you want them to appear.
- **Not done:** no automatic text confirming an opt-out worded in free text (Twilio only confirms its own keywords).
  Nothing was sent through live Twilio or Resend.

## Protect your file: freezes, fraud alerts and opt-outs the client places personally (unreleased)

Migration 0022 (additive, safe to run again, no superuser): `clients.file_protections` (jsonb, default `{}`) and a
trigger that lets only the client write it, and only as option -> day. No table, no policy change.

- **Registry** (`src/lib/credit/protections.ts`): security freezes, fraud alerts, opt-outs, consumer statements and
  file disclosures for Experian, Equifax, TransUnion, Innovis, ChexSystems, Early Warning, LexisNexis, NCTUE and
  OptOutPrescreen.com. Each says in one sentence what it does and what it does not do (a freeze does not remove or
  correct information; an opt-out does not delete records), and is always requested by the consumer. A link, phone
  number or "Free" mark is stored only with the official page it was read on and the day (all read 2026-11-19).
  Not confirmed, so not stored: an Early Warning freeze, a ChexSystems page for consumer statements, bureau phone numbers.
- **Portal** (`/portal/protect`, English and Spanish, linked from the portal home): the options by agency with the
  official links and a tick "I placed this on <date>". The agency never submits these and no agency login, PIN or
  password is collected (a freeze is requested directly by the consumer, 15 U.S.C. 1681c-1(i)(2)).
- **Staff**: "Freezes, alerts and opt-outs" on the client's Reports tab shows the client's ticks, read-only. The
  database refuses a tick from staff.
- **Credit guide**: the freeze and fraud alert entries now say what they do not do and link to the page; new entries
  for the prescreen opt-out (15 U.S.C. 1681b(e)) and for freeze vs fraud alert vs opt-out vs dispute.

## Work statement, charge check and evidence pack (unreleased)

Migration 0020 (additive, safe to run again, no superuser): `clients.sold_by_phone` (nullable = not answered, staff-only by
trigger) and two narrow read functions, `app.client_document_reviews` and `app.client_portal_signins`. No table, no
policy change. The statement is never stored; it is built on request from existing records.

- **Work statement** (`src/lib/billing/statement.ts`): per client and month, from records only: letters sent (date,
  recipient, method, tracking reference, "recorded by staff" or "confirmed by carrier"), letters approved, responses
  with the outcome as recorded, documents reviewed, messages sent and received, and what is waiting on whom today.
  Staff: "Work statement" on the client record (`/app/clients/[id]/statement`, prints cleanly). Client: "What we did
  for you" in the portal (`/portal/statement`, English and Spanish), linked from the portal home. A month with no
  records says "No work is recorded for this month."
- **Charge check** (`src/lib/billing/eligibility.ts`, pure): "Eligible to charge" only when a signed service agreement
  is in force and its 3-business-day cancellation period has ended (15 U.S.C. § 1679e(a)), at least one letter is
  recorded as sent in the work period on or before the charge date (15 U.S.C. § 1679b(b)), and the client is not
  cancelled. Otherwise "Hold" with the reasons. Shown on the client's Billing tab above "Record a payment". Recording
  a payment on hold needs a confirmation; the acknowledgement and the reason codes go to the audit log
  (`payment.recorded`). The server re-runs the check, so a stale page cannot skip it.
- **Sold by phone**: a checkbox on the Billing tab. It adds a caution citing the Telemarketing Sales Rule
  (16 CFR 310.4(a)(2)) to review with counsel. It is not a legal determination.
- **Evidence pack** (`/app/clients/[id]/evidence`, settings or billing access, prints cleanly): signed agreements and
  disclosures with timestamp, typed signature and IP; the cancellation notice acknowledgement if one is on record;
  letters sent; the communications log; portal sign-in dates; payments recorded.
- **Business days** (`src/lib/business-days.ts`): the one import point for business-day arithmetic. It re-exports the
  holiday table and helpers from `src/lib/disputes/clock.ts`, so there is still a single table.
- **Changed**: the new-plan form on Billing no longer preselects "Monthly"; the person chooses. Billing states that
  pricing and billing practices are the agency's responsibility. No fee model is built or recommended.

## Reinsertion watch, date-of-first-delinquency check and fall-off dates (unreleased)

No migration: the existing `findings`, `tradelines` and `public_records` columns hold everything (0021 is unused).

- **Reinsertion watch** (`src/lib/disputes/reinsertion.ts`): when findings are regenerated (a report is approved, a
  line is edited, or "Re-run analysis"), the newest approved report of each bureau is checked against bureau disputes
  recorded as deleted. A finding "Possible reinsertion" is created when the same client, same bureau and exact match
  key (creditor plus account last 4) appears on a report dated after the response was recorded. It states both facts
  and asks staff to check whether the client received the written notice (15 U.S.C. § 1681i(a)(5)(B)). It does not
  say a violation occurred. One finding per deleted dispute; "Start dispute" works as for any finding.
- **Fall-off date** (`src/lib/credit/reporting-period.ts`, 15 U.S.C. § 1681c): 7 years from the reported date of first
  delinquency; for collections and charge-offs the 7 years start 180 days after it; bankruptcies 10 years from the
  filing date. Shown as "Generally reportable until <date>" on negative items in the report review and the
  three-bureau comparison, or "Fall-off date not available" when the report gives no date. The client's Reports tab
  lists "Aging off within 12 months" (hidden when empty). No score is predicted anywhere.
- **Date mismatch**: the cross-bureau date-of-first-delinquency finding now needs the account's last 4 and says the
  dates differ and should be checked against the client's records. New: a collection whose date of first delinquency
  is later than the one on the original creditor's account (same bureau, exactly one candidate account).
- **Changed**: the "older than 7 years" finding now uses the same arithmetic, so a collection or charge-off is flagged
  only after 7 years plus 180 days. "Charged off" (with a d) is now recognised as negative.

## Legal clock, optional next steps and letter specificity check (unreleased)

Every deadline on a dispute with a credit bureau or specialty agency is now computed in one pure module with its
section of 15 U.S.C. § 1681i beside it. Migration 0019 (additive, safe to run again, no superuser): outcome
`frivolous`; `disputes.more_info_on`, `investigation_completed_on`, `frivolous_missing`, `client_confirmed_accurate`;
`letters.received_on`, `reply_due_on`, `reply_received_on`.

- **Legal clock** (`src/lib/disputes/clock.ts`, shown on the dispute): 30 days from receipt; up to 45 when staff record
  "client sent more information on <date>" (only a date inside the first 30 days); written results due 5 business days
  after a recorded completion date. Business days skip weekends and the federal holidays for 2025 to 2030 (OPM). The
  45-day tick at submission stays as the manual choice (for example a dispute that follows a free annual report).
- **Optional next steps** after "verified as reported": a request for the description of the reinvestigation
  procedure (a normal draft letter, English and Spanish, with a 15-day clock once it is recorded as sent), a consumer
  statement, the client's own direct dispute with the furnisher, and the client's own CFPB complaint with a plain
  summary of recorded dates. Each says what it is and is not. Nothing is automatic, and nothing is offered once staff
  record that the client confirmed the item is accurate.
- **No response recorded by the deadline**: the same block asks staff to check the mail and portal first, then offers a
  follow-up for the results, the direct dispute and the complaint. It describes the record and asserts nothing else.
- **Specificity check**: a bureau or specialty dispute letter cannot be sent for approval, or approved, until it names
  the account with a masked number or reference, states what is disputed, gives a concrete reason and lists its
  enclosures or says "none". The letter page lists what is missing. Drafted letters now list accepted identity
  documents as enclosures, or "Enclosures: none".
- **Frivolous or irrelevant notice**: staff type what the agency said was missing; that becomes a task and a document
  request the client sees. Portal outcome text added in English and Spanish.

## Client updates by text message and email (unreleased)

Clients can be told by text and by email that there is something new in their portal. Off everywhere until switched on.
Migration 0018 (additive, safe to run again, no superuser): `sms_consents`, `client_updates`, `sms_inbound`, an index
on client phone digits, and the inbound-message trigger now says "text message" for a text.

- **SMS driver** (`src/lib/sms.ts`): `SMS_DRIVER` = `disabled` (default), `twilio`, or `log` (development and test
  only; refused in staging and production). Twilio is called with `fetch`; no new dependency. It never throws.
- **Consent.** A client turns texts on or off in Portal → Profile (English and Spanish). The exact wording shown, the
  number, the time and the source are stored. Staff can record a verbal consent only with a note, and it is labelled
  "Recorded by staff". Records are revoked, never edited. No consent in force for the number on file: no text.
- **Six events**, each with a text and an email in both languages: dispute sent, response recorded, document needed,
  document rejected, investigation window passed with no response, new message from the team. A text never names an
  account, an amount or a result. Settings → Client updates has a switch per event and channel; a channel that is not
  connected shows why and cannot be switched on.
- **Rules.** One message per client, event, subject and channel; 3 texts and 6 emails a day per client; texts held from
  9 p.m. to 8 a.m. (`APP_TIMEZONE`); sent after the triggering request finishes or by the scheduled job. Every attempt is
  on the client's Messages tab with its status and provider id; failures are listed in Settings.
- **Twilio webhook** `POST /api/webhooks/twilio`: signature-verified, rate limited. STOP revokes consent; START does not
  restore it; other replies are saved on the matching client or kept unmatched for review.
- **Scheduled jobs** now run twice a day on Vercel (09:00 and 17:00 UTC), because the 09:00 run is inside quiet hours.
- **Docs:** Twilio and Resend setup steps in `docs/INTEGRATIONS.md` and `docs/DEPLOY-VERCEL.md`. No calls, no dialer.
- **Not verified:** nothing was sent through the live Twilio or Resend services. The Twilio request, signature and
  keywords follow its documentation (signature checked against the documented example). Delivery right after a request
  (Next.js `after`) was not exercised in a running server; the scheduled job path is covered by tests.

## Review fixes for agency websites, intake documents and specialty agencies (unreleased)

- **Website claims check rewritten.** It no longer deletes text before checking. A guarantee word (English, Spanish,
  and the "guarentee" misspelling) passes only when a negation directly governs it ("no result is guaranteed", "we
  cannot guarantee", "nadie puede garantizar"). Removal claims are matched as a removal verb near a negative item, in
  either order. Added: improve/better/higher score wording, "within / as few as / N-day" results, promises and
  money-back offers, no-cost wording, "qualify for", tradelines for sale. "Free credit consultation" and "Free
  15-minute call" are now accepted. It is still a safety net, not a legal review.
- **Business name** is checked when a site is published, and renaming to a prohibited claim is refused while it is.
- **Unpublish** is a direct write that validates nothing and never rewrites the saved text.
- **Database backstops.** 0015: a client's own upload must start unreviewed (`documents_self_insert`). 0017: the portal
  guard trigger also covers `clients.banking_concern` and `specialty_reports`. 0015 now widens the kind lists instead of
  rewriting them, so it is safe to run again after 0017.
- **Specialty letters.** ChexSystems, NCTUE and Early Warning: what each agency's page says a mailed dispute must carry
  is quoted on the new-dispute step, the dispute and the letter, with the page and date. The letter has marked lines
  for date of birth and Social Security number (ChexSystems, NCTUE) or the consumer ID (Early Warning, a new optional
  item field); the app never fills these in and the letter cannot be approved until a person does. The
  identity-document warning and the "Enclose with this letter" list now apply to specialty disputes too.
- **Addresses.** LexisNexis no longer has a stored dispute address (its page could not be opened in review), so staff
  type it. TransUnion now cites its dispute-by-mail page; Equifax cites the Experian page that prints its address.
- **Not confirmed:** nobody re-opened the TransUnion page behind the "two months" proof-of-address advice; it is marked
  as such in `src/lib/intake.ts`. The agency pages could not be opened from the build environment at all, so the
  ChexSystems, Early Warning and NCTUE addresses and quotations rest on the review, not on a second reading.

## Specialty reporting agencies (unreleased)

Disputes are no longer limited to the three credit bureaus. Migration 0017 (additive): `disputes.agency`, `agency_item`
and `recipient_address`; `agency` added to the dispute target types and `specialty` to the workflows;
`clients.banking_concern` and `specialty_reports`; document kind `specialty_report`. The `disputes.bureau` column and its
three-bureau check are unchanged, so every existing dispute, report, comparison and count behaves as before.

- **Registry** (`src/lib/credit/agencies.ts`): the three bureaus plus ChexSystems, Early Warning, LexisNexis, Innovis,
  NCTUE, TeleCheck and Clarity Services: what each reports, how to request the free disclosure, and the dispute address.
  An address is stored only with the official page it was read on and the date; where the agency's page does not state
  one, none is stored and staff type it in. Nothing is prefilled from memory.
- **Staff:** New dispute gains "Enter a specialty agency item": agency, the item as it appears on the disclosure, and a
  required reason. It then runs through the same draft, review, approval, letter, submission, 30-day window and outcome.
- **Letters:** one specialty template per kind of agency, in English and Spanish. It states only what was entered, refers
  to the right to dispute under the FCRA in general terms and asks for a reinvestigation and a written result.
- **Client record:** a "Specialty reports" block on the Reports tab (how to request each free report, a status staff set,
  the received file) and a "banking or background-screening concern" tick box. These reports are not read by the system.
- **Portal and guide:** specialty items appear in the client's items list with the same statuses and day meter and a
  one-line "About" for the agency; the guide gains entries on ChexSystems / Early Warning and LexisNexis (EN/ES). The
  client plan suggests requesting the ChexSystems and LexisNexis reports only when the concern box is ticked.
- No data feed from any of these agencies exists; see docs/INTEGRATIONS.md.

## Identity document intake (unreleased)

The identity documents a credit bureau normally asks for with a mailed dispute are collected from day one. Migration
0015 (additive): `documents.review_note`, `doc_date`, `expires_on`, and three more document kinds (`previous_address`,
`name_change`, `power_of_attorney`).

- **One definition** (`src/lib/intake.ts`): photo ID, proof of current address, proof of Social Security number, each
  with what counts and plain tips in English and Spanish; five "only if this applies" items that are never required.
  The bureaus' own instructions are cited in the file. Status per client is computed from real documents: missing,
  awaiting review, accepted, rejected (with the reason), expired or no longer recent (only from a date a reviewer recorded).
- **Portal:** "Your documents checklist" at the top of Documents, with progress and one upload button per item that opens
  the existing upload form with the type chosen. The portal home next step points to it after agreements and named requests.
- **Staff:** an "Intake documents" block on the client's Documents tab: accept (optionally recording the expiry or
  document date), reject with a reason the client sees, and "Ask the client for the missing ones" (ordinary document
  requests; no email is sent). The client plan gains "Collect identity documents".
- **Sending:** recording a bureau dispute as sent without accepted identity documents shows a warning and needs
  "Send without the identity documents" ticked. It is a confirmation, not a block, and is noted on the dispute.
  The consent and approved-letter gates are unchanged.
- **Letters:** an approved letter to a bureau lists "Enclose with this letter" from the accepted documents. Nothing is
  attached to the PDF.
- e2e: `journey.cjs` and `dispute-workflow.cjs` tick the new confirmation before "Record submission".

## Agency websites (unreleased)

Every agency workspace can publish its own public website, hosted by the app at `/a/<workspace-slug>`. No migration:
the content is one key (`website`) in `organizations.settings`, so the existing tenant policies decide who may edit it.

- **Public site** (`src/app/a/[slug]`): the agency's name, mark and brand colour; hero, services, the fixed "how it
  works" steps, about, questions, contact details and the enquiry form (same `submitLead` checks; source `website`);
  a "Client sign in" link; and a fixed footer with the required notices, the agency's name and mailing address.
  English, or Spanish with `?lang=es` (fixed copy is translated; the agency's own text is shown as written).
- **Editor** at `/app/website` (owners and admins, agency workspaces): plain text with length limits, starter text,
  publish/unpublish. An unpublished site answers "page not found".
- **Claims check on save** (`findMarketingClaims` in `src/lib/compliance/claims.ts`): promises of results or removal,
  quoted scores, timed results, approval promises and "free" offers other than a first consultation are refused, in
  English and Spanish, with the field and the reason. The existing guard for system-generated text is unchanged.
- **SEO**: per-site title, description, canonical and Open Graph; `ProfessionalService` and FAQ structured data with
  only the fields provided; published sites listed in `/a/sitemap.xml`, which `robots.txt` now names next to
  `/sitemap.xml`.
- **Leads page** offers the published site first; the enquiry-form links stay. `/start/<slug>` links back to the site.
- **Not built:** custom domains (listed as manual under Settings → Integrations) and a per-agency link-preview image
  (previews use the app's default image).

## Vercel + Supabase readiness (unreleased)

Everything needed to run on Vercel (serverless, no persistent disk) against a Supabase database through its connection
pooler. Step-by-step guide and the full variable table: `docs/DEPLOY-VERCEL.md`. Not yet exercised against the real services.

- **Database-backed document storage** (`STORAGE_DRIVER=db`, migration 0014 `stored_objects`): same at-rest encryption and
  key format as the disk driver (still the default). The table has row-level security and no tenant grants or policies.
- **Non-superuser database owner.** Migration 0014 grants `disputeos_rls` to the owner (needed for `SET ROLE` on
  PostgreSQL 16+) and stops with the statement to run when it cannot. It also removes the table privileges Supabase
  gives its Data API roles (`anon`, `authenticated`, `service_role`).
- **Connections** (`scripts/pg-config.mjs`, used by the app and every script): a remote database is always reached over
  TLS with the certificate verified; `DATABASE_CA_CERT` supplies a private CA; `?sslmode=disable` is the only opt-out,
  for private networks, and is refused on Vercel. **Behaviour change:** a remote `DATABASE_URL` without TLS used to connect in plaintext and is
  now refused unless it says `sslmode=disable`. Pool size is `DB_POOL_MAX` (default 10; 3 on Vercel).
- **`npm run vercel-build`** migrates, then builds (a Vercel Preview build skips the migrations); it fails the build when `DATABASE_URL` is missing or a migration
  fails. Migrations now take a transaction-scoped lock so concurrent builds cannot collide. `build` is unchanged.
- **Scheduled jobs:** `vercel.json` schedules `GET /api/jobs/run` daily; the route now answers GET as well as POST, with
  the same `Authorization: Bearer <CRON_SECRET>` check.
- **Upload limit** is `MAX_UPLOAD_MB` (default 10; 4 on Vercel). The server check, the browser check (now also on the
  staff upload forms) and every message in English and Spanish use that one number.
- **`EMAIL_DRIVER=disabled`**: an explicit way to run production without an email provider. Nothing is sent and the app
  says so; password reset by email is unavailable in that mode. The `log` driver is still refused in production.
- **Production on Vercel refuses** disk storage, a missing `CRON_SECRET` and an upload limit above 4 MB.
- `npm run secrets:gen` prints fresh values for the generated secrets (writes no file).

## Night Desk redesign: review fixes (unreleased)

Fixes from the design, accessibility and accuracy review of the redesign. Presentation only, except where noted.

- **No sideways page scroll.** The dispute pipeline board and the dispute page no longer widen the page (2184px / 523px before). Every
  sideways scroller is now a positioned box so visually-hidden labels are clipped with it. On phones the dispute's seven-step
  pipeline is one line in words ("Step 4 of 7: Submitted") with a segmented bar.
- **Staff tables on phones** (`.table-stack` in `globals.css`): disputes, clients, letters, team, leads and a client's disputes
  and letters stack into rows below `sm` — title wrapping on its own line, then status, the investigation-window meter, date and
  the one action. The AI credit ledger is a plain list. Nothing important sits behind an unannounced scroll.
- **Investigation window counted from receipt.** "Day N of M" and the bar now start at the deadline minus its 30 (or 45) days
  (`windowStart` in `src/lib/day-meter.ts`), so M is always 30 or 45. It used to be measured from the mailing date, which read
  "Day 5 of 35" when a letter was recorded five days after it was sent. Days left and days overdue are unchanged. New unit tests.
- **Branded "not found" pages** (`src/app/not-found.tsx`, `src/app/app/not-found.tsx`). A damaged or expired unsubscribe link now
  explains itself in English and Spanish instead of a bare 404.
- **Client portal:** the credit-guide launcher is a round icon button (labelled for screen readers) so it no longer covers the
  rights text or forms; every page uses one left-aligned content column; the full legal note stays on Home, My items and Profile and
  the other pages carry one line linking to "Your rights"; "Sent —" is now "Sent, date not recorded" / "Enviada, fecha no registrada".
- **Raw values removed:** a letter's recipient shows as "Equifax", not `equifax`; report sources read "file upload", "CSV import".
- **Less clutter:** the report review is one divided list (four figures per account, the rest behind a disclosure); a client's
  Reports tab is grouped by bureau with earlier reports folded away; Settings has an in-page section nav and collapsible
  integration rows; Leads shows one status line for automatic follow-up with the detail behind "How it works" (opt-out and
  postal-address copy stay visible); AI credit refund rules sit behind a disclosure. With a short queue the dashboard figures
  move up beside the windows panel.
- **Empty states** have no dashed box: a display-face title, one sentence and one action.
- **AI mark on the dashboard:** letters awaiting approval whose current text is an AI draft carry the spark, as on the letters list.
- **Marketing accuracy:** removed the claim (and the hero picture) that AI suggestions cite their source fields; the copy now
  describes what exists: the suggestion beside the current text with changed lines marked, discarded if a number or date changes.
- **Pricing structured data** no longer publishes the proposed prices as schema.org offers; billing is not connected.
- **Portal colour:** the picker starts from the product colour (#3b49d1) and submits nothing until a colour is actually chosen, so
  saving another setting cannot quietly store a brand colour. "Use the standard colour" clears a chosen one.

## 0.2.0 — Product takeover (unreleased)

Consolidates the two diverged Copilot branches (`copilot/disputeos-phase-1-scaffold-auth`, `mrderekyt-disputeos-preview`)
into one codebase. Both branches are untouched. See `docs/ENGINEERING_ASSESSMENT.md` for the audit.

### Replaced / removed (with reasons)
- Supabase Auth/PostgREST/Storage → first-party auth + direct PostgreSQL with RLS (Supabase's stack cannot run in the build
  environment, so nothing depending on it could be verified). The database still runs on Supabase's Postgres if you wish.
- Preview branch demo data (`DEMO_CLIENTS`, fabricated score/spend figures) and the "any signed-in user is admin" check.
- `next-intl`, jest/ts-jest, `@sentry/nextjs`, radix/cva/clsx/tailwind-merge.

### Added
- Multi-tenant schema (6 migrations) with row-level security on every table; append-only audit log; portal triggers.
- Auth: sign-up, login, lockout, rate limits, TOTP MFA, password reset, change password, staff & client invitations, revocable sessions.
- CRM, document vault (encrypted), consent ledger, tasks, notes, messaging, timeline, segments, export & delete.
- Report import (PDF/HTML/text/CSV), parser with confidence, review & approval, three-bureau comparison, discrepancy findings.
- Dispute pipeline with rounds, deadlines, evidence, audit trail; letter center with 11 templates (EN, with ES for the main letters), PDF, versions, approvals.
- AI assistant (modular providers, fact-preservation guard), claims guard, automation engine with safeguards.
- Client portal (EN/ES), team management, analytics, billing records, settings, integrations status, audit viewer.
- dev/test/staging/production configuration with boot-time validation; CI workflow; docker-compose.
- 180 automated tests + a 25-step browser journey.

### Added after the takeover audit (Credit Connect & differentiators)
- **Credit Connect:** consent-gated automatic import (provider adapter framework + dev-only sandbox) and a public REST API with
  scoped, hashed, revocable API keys (`POST /api/v1/clients/{id}/reports`, clients, disputes, OpenAPI). Live providers (Array, IDIQ,
  bureaus) are listed honestly as needing partner access — see `docs/CREDIT_CONNECT.md`.
- Reported-score history (real values only) for staff and the client portal; command palette (⌘K); white-label portal colour with
  guaranteed contrast.
- 30 more tests (210 total) and a 28-step browser journey.

### Client-first pass
- **Rename-ready:** the product name is defined once in `src/lib/product.ts`; the ~30 hard-coded occurrences across 25 files now read from it.
- **The portal belongs to the agency:** agency name + monogram + colour in the portal header; branded sign-in page at
  `/portal/login?org=<slug>` (link shown in Settings and included in every invitation; sign-out returns there); client invitation
  page branded too. Personal workspaces are never discoverable by slug. Software name reduced to a "Powered by" line.
- **Portal home:** one "Your next step" card (sign / upload / response under review / investigation under way with the real expected
  date / we're working on it / nothing waiting), the current stage explained, a "Your rights" card (free weekly reports, disputing for
  free, accurate information can't be removed, 30/45-day investigations, 3-day cancellation), message-your-specialist call to action.
- **Phones:** app-style bottom navigation; icon sign-out; wider State field.
- **Spanish:** dates and relative times are now localised (they were English).
- **Staff dashboard:** "Client care" queues — unanswered client messages, client uploads to review, clients with no update in 14+ days.
- **Landing page:** "Client experience" section with a clearly labelled sample-data illustration.
- 13 more tests (223 total); browser journey extended to 31 steps.

### Pilot-readiness pass
- **AI letter polishing rebuilt.** The old check compared sets of numbers and accepted a rewrite that swapped the Experian and
  Equifax balances, and another that renamed the creditor. Fact-bearing sentences (names, amounts, dates, account references,
  bureau names, citations, dispute statements) are now replaced by opaque markers before anything is sent to the model and
  restored server-side; a missing, repeated, reordered, altered or moved marker — or any factual wording added by the model —
  discards the rewrite and keeps the original. Staff see a before/after preview; nothing is saved until they accept, the
  accepted text is re-validated on the server, and it is saved as a draft that still needs approval.
- **`npm run jobs:run` works** (it pointed at a missing file). Scheduled jobs share one code path with `/api/jobs/run`, record
  every run in `job_runs`, roll back and report a failing organization without stopping the others, and are safe to retry.
- **Delivery records.** Submission captures method, date sent and an optional tracking reference, stored as a staff record and
  shown as "Recorded by staff"; "Confirmed by carrier" is reserved for a mail integration and cannot be set by hand.
- **Dashboard and navigation.** Overdue deadlines, letters awaiting approval and unanswered messages come first; one
  "New client" button; navigation grouped into Daily work / Tools / Business.
- **Integration status** is labelled by what works in the configured environment, with the manual path and the exact remaining
  dependency for live credit pulls, certified mail, payments, SMS and external e-signature.
- **Fixed:** portal clients got "not found" when downloading their own approved/sent letter (missing row-level policy).
- **Fixed:** the "Record submission" form was offered before a letter was approved or consents were recorded.
- New browser test `e2e/dispute-workflow.cjs` (11 steps, synthetic data) and 19 more automated tests (248 total).

### Client plan, monitoring link, read-as-report and audit fixes
- **Client plan:** a short action plan on the client profile, built only from that client's own records (reports, consents,
  findings, disputes, reported balances and limits). No AI and no score or outcome predictions.
- **Monitoring referral link:** an agency can set an https link to a paid credit-monitoring service in Settings; clients see it
  in the portal as a paid option, with the note that the agency may earn a commission. It is only a link — nothing is imported.
- **Read an uploaded document as a report:** a credit-report file already in the client's vault (for example one the client
  uploaded in the portal) can be read as a report without uploading it again. It goes through the same review and approval.
- **Audit fixes:**
  - One definition of "today": `APP_TIMEZONE` (default `America/New_York`) now decides sent-on dates, the "Date sent" default
    on the dispute and letter pages, task Overdue/Today grouping and the analytics overdue count. A sent date that is not in
    the past is recorded as now, never as a future time.
  - `x-forwarded-for` is read from the right (`TRUSTED_PROXY_HOPS`); staging/production refuse the `log` email driver;
    `/api/health` probe; error pages for the app and the portal.
  - A specialist's ordinary action no longer fails when it fires an automation (migration `0010`). The new insert policy is
    limited to the specialist's own organization's automations, undecided runs and the two states the engine writes.
    A specialist can still, at the database level, log a pending run that a manager must approve — approval remains the gate.
  - Refusals after a redirect (Team page, restoring a letter version) use fixed messages chosen by a short code; text from
    the URL is no longer shown. `?page=` on Disputes and Letters is limited to a whole number from 1 to 100,000.
  - Portal messages reach clients in their saved language; changing the language confirms in the new one.
- 302 automated tests in 21 files.

### Finishing pass
- **Enquiry form for new leads:** each agency gets a public, branded form at `/start/<slug>` (link in Settings). A submission becomes
  a lead with a follow-up task and appears under "New leads to contact" on the dashboard. Contact details only; consent to be
  contacted required; rate limited; honeypot; identical reply for emails already on file; personal workspaces excluded.
- **Draft several disputes at once:** tick findings on the three-bureau comparison and draft one dispute per finding, each with its
  reason written from that finding's evidence. They are drafts: review, approval and an approved letter are still required. Findings
  that cannot be drafted safely are skipped with the reason shown.
- **Fixed:** every form lost what the person had typed when it came back with an error (found by the browser journey).
- **Fixed:** score cards squeezed their dates into a narrow column on the client profile.
- 6 more tests (229 total); browser journey extended to 33 steps.

### Leads and automatic follow-up
- **Leads page** (`/app/leads`, in Daily work): the enquiry-form link plus ready-made tagged links (`?src=instagram`, facebook, tiktok,
  google, flyer, referral); counts from the database (enquiries this week, waiting for first contact, contacted, became clients) and
  by source; the list of open leads with search by name, 25 per page, "Convert to client" and "Mark not interested".
- **Source tracking:** `/start/<slug>?src=<tag>` stores a sanitised tag (`[a-z0-9-]{1,30}`) as the lead's source; without it the
  source stays "Website form".
- **Automatic follow-up email** to people who sent the form and agreed to be contacted: welcome, a follow-up after 2 days, a last
  note after 6. Off by default; an owner or admin switches it on and must save a postal address and a reply address first. It stops
  when the team messages the lead or logs a call, when staff press "They replied" or "Asked to stop" on the lead, when the lead
  becomes a client, or when they use the opt-out link in every email (`/unsubscribe/<signed token>`, no sign-in). **Email replies
  are not read by the system:** they go to the agency's reply address, so a reply stops the emails only once someone records it. Fixed EN/ES wording, checked by the claims guard. Each (lead, step) is sent once
  (`lead_outreach`, migration 0011); each send is recorded in Messages and the timeline.
- **Not connected means not sent:** with the `log` email driver nothing is sent and nothing is recorded as sent, and the Leads page
  says so. No SMS, no purchased lists, no scraping.
- The public enquiry form now has a title and description with the agency's name, so shared links preview as theirs.
- `sendEmail` accepts an optional `replyTo`. The dashboard's "New leads to contact" no longer drops a lead just because an
  automatic email went out.

- **Review fixes (same release):**
  - The page and every email no longer imply that replying stops the emails. Each email's footer says a reply reaches the team
    but does not stop the automatic emails, and the link does. New "They replied" (logs an inbound message) and "Asked to stop"
    (same effect as the opt-out link) buttons on each lead.
  - Sending is now claim → send → record: the step is committed as `sending` first, the email is sent with no transaction or row
    lock open, and the result is written afterwards. If the result is never written (crash, lost connection) the step stays
    `sending`, is shown as "not confirmed" and is **not** sent again, and nothing later is sent to that lead — one email can be
    lost, none duplicated. All stop conditions are re-checked under a row lock immediately before each claim.
  - The greeting uses only a plain first name (letters, apostrophes, hyphens, 30 characters); anything else typed into the public
    form becomes "Hi there". The From line shows the agency's name with the platform's sending address.
  - The welcome email is no longer sent inside the enquiry request (it runs after the response via Next's `after`; the scheduled
    job sends it if that is lost), so response time does not reveal whether an address was already on file.
  - A staff email that failed, or was only written to the log because no email service is connected, no longer counts as
    "contacted" and no longer stops follow-up.
  - A Leads page past the last page redirects to the last page with leads instead of showing "No open leads yet".
  - Not done: reading replies automatically (needs an inbound-email webhook). The Resend driver, including the new From name, is
    still untested against the live service.

### Credit guide (chat box)
- **Ask the credit guide** button at the bottom right of the client portal (above the phone bottom bar) and the staff app. It
  explains credit reports, disputes, timelines, collections, identity theft, CROA rights and where things are, in plain language
  (EN/ES in the portal), from a vetted knowledge base of 38 entries in `src/lib/guide/knowledge.ts`.
- Each reply has three parts: the knowledge-base answer; "For you right now" — up to three steps from the asker's own records
  (portal: only their client record; staff: the plan of the client page being viewed), loaded under row-level security; and links
  to existing screens. The guide explains and links; it performs no account action and stores no conversation.
- Works with no AI configured (deterministic keyword matcher; unknown questions get "I am not sure" plus topics). With
  `AI_PROVIDER` configured, the model may only re-phrase the retrieved entries: the question is sent as untrusted text with names,
  numbers, amounts and addresses masked; step text is replaced by generic labels; output is discarded for prohibited claims
  (English guard plus Spanish rules), any number or web address not in the entries, prompt markers, or excess length. Like the
  other adapters, this path is tested against a fake provider only, not a live service.
- Limits: 500 characters per question; 20 (portal) / 30 (staff) questions per 5 minutes per user. No new tables.
- **Review fixes:** AI-written wording is now also checked by stricter rules that need no number — any future-tense or promise
  wording about a score, a removal or an approval, and any suggestion to dispute accurate information, in English and Spanish
  ("this will raise your score", "su puntaje subirá", "even if it is accurate"). They are pattern rules, not a proof: they catch
  the phrasings tested, and a miss is still possible. A match only means the vetted text is shown instead. In the staff app the
  guide button is a 48px circle with no label, and the report review bar leaves room for it, so it no longer sits on "Approve
  report" (checked from the layout classes, not in a browser).

### AI credits (metered AI)
- **Nothing about AI is free.** Each AI result that is returned costs credits from the workspace's balance: letter wording
  suggestion 5, progress note polish 2, AI-worded guide answer 1 (`AI_COSTS`, `src/lib/ai/credits.ts`). With no credits, or
  no AI provider, the app uses its existing non-AI wording and tells staff why; portal clients just get the vetted answer.
- Migration 0012: `ai_credit_ledger`, append-only, balance = `sum(delta)`. Staff of the organization may read it; only the
  system connection can write. Credits are taken when the model is called (race-safe, per-organization lock) and given back
  if the call fails or its output is discarded by the safety checks.
- Wired into every model call: letter suggestion, staff and portal credit guide (portal questions use the agency's credits),
  and the progress note.
- **Changed:** the client progress note no longer calls the model when the Messages tab loads. The draft is built from the
  dispute data for free, and "Polish wording with AI (2 credits)" is a separate button — a page reload can never charge.
- AI assistant page: balance, price list, last 20 ledger entries (owners/admins). Balance shown beside "Suggest better wording".
- `npm run credits:grant -- <org-slug> <amount> [note]` for the platform operator (validated, audited). New workspaces start
  at 0. The demo seed adds 100 labelled sample credits.
- **Not connected:** buying credits online. The app says so, and Settings → Integrations lists it as a manual path.
- 24 new tests (`tests/unit/ai-credits.test.ts`, `tests/db/ai-credits.test.ts`): spend, refusal, concurrent spends,
  refunds, append-only, row-level security, the letter path with a fake provider, the guide on credits, the operator script.
- **Fixed after review (migration 0013):**
  - The press that spent the last credits on a progress note polish could lose the polished text, because the refreshed
    page removed the button that held it. The button now stays whenever a provider is connected.
  - A charge whose request died before a result, or whose refund could not be written, stayed charged. Charges are now
    reservations with a recorded outcome; the scheduled jobs refund any without one after 10 minutes, and a failed refund
    no longer hides the original error or claims "no credits were used". Staff and portal layouts set `maxDuration = 60`.
  - A paid letter suggestion existed only in the browser. It is now stored per letter version, shown again after a reload,
    and not charged twice for the same version. (The polished progress note is still not stored.)
  - Portal clients could spend the agency's balance with only a rate limit. AI wording in the portal guide is now off
    until an owner or admin turns it on (AI assistant → AI credits), and capped at 10 AI-worded answers per client per 24 hours.
  - 13 more tests for the above.

### Defects found and fixed in the client-first pass
- Disputes that were approved-but-not-mailed or on hold showed a **blank status** to clients (no portal text for those statuses); now
  covered by a test that every client-visible status has text in both languages.
- The portal's "Items sent" counted approved letters that had not been mailed; it now counts only items actually submitted.
- "Response expected by" showed for items that already had a response.
- Relative times showed "in <1m" for something created a moment ago (app/database clock skew).
- The new phone navigation bar was pinned to the header because the header's backdrop blur creates a containing block for
  fixed elements (caught by the browser journey; the bar now renders outside the header).
- Empty event lists rendered an orphan divider on dispute cards.

### Defects found and fixed during verification
- Checkboxes without a `value` submitted `"on"`: API-key permissions failed, and a dispute's "specific information to review" selection was silently dropped.
- Unchecked checkboxes failed validation on every form (found by the browser journey).
- `'use server'` files re-exporting constants crashed two pages (found by the browser smoke test).
- Audit-log immutability blocked deleting any user/organization (schema fix; offboarding test added).
- Cooldown windows could be violated across calendar-bucket boundaries (now a rolling window).
- Timestamps returned as `Date` objects contradicted the row types (driver now returns ISO strings).
- Audit events in one transaction shared a timestamp (now `clock_timestamp()`).
- Blocked-claims guard missed "we can remove accurate information".
- "Dispute progress" counted unsubmitted disputes.
- Parallel queries on one connection triggered a `pg` deprecation (queries are now serialised per transaction).
- Client portal upload gave no confirmation after the request row disappeared.
