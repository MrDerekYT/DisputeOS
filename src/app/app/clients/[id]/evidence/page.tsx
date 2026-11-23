import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { PrintButton } from '@/components/print-button';
import { PageHeader } from '@/components/ui';
import { loadAgency } from '@/lib/agreements';
import { requireStaff } from '@/lib/auth/context';
import { EVIDENCE_COMMS_LIMIT, loadEvidencePack } from '@/lib/billing/records';
import { sayDay } from '@/lib/business-days';
import { consentTitle, contractPeriod, isConsentKind, signatureSource } from '@/lib/compliance/disclosures';
import { PRODUCT } from '@/lib/product';
import { dayInZone, fmtDate, isUuid, money } from '@/lib/util';

export const metadata: Metadata = { title: 'Evidence pack' };

const METHOD: Record<string, string> = { certified_mail: 'Certified mail', first_class_mail: 'First-class mail', portal: 'Online portal', manual: 'Other' };
const DIRECTION: Record<string, string> = { inbound: 'From client', outbound: 'To client' };

function Part({ title, children }: { title: string; children: ReactNode }) {
  return <section className="break-inside-avoid"><h2 className="mb-2 text-[0.9375rem] font-semibold">{title}</h2><div className="text-sm">{children}</div></section>;
}
const None = ({ children }: { children: ReactNode }) => <p className="text-muted">{children}</p>;

/**
 * Chargeback evidence pack: one printable page of what is on record for a client — signed agreements, letters sent,
 * the message log, portal sign-ins and payments. Records only; nothing is summarised or added. Staff with settings or
 * billing access. Days are the agency's own (Settings → Client updates → time zone), the days the client's Notice of
 * Cancellation states. A paper signature staff recorded keeps the app's text on the recording day (dated with the date
 * on the paper, from which its cancellation period runs), not a copy of the paper, and is labelled so. In a personal
 * workspace what is on file was given by the account holder in the app, and is labelled so.
 */
export default async function EvidencePackPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const ctx = await requireStaff();
  if (!ctx.can('settings:manage') && !ctx.can('billing:read')) redirect('/app?denied=1');
  const d = await ctx.tx(async (db) => {
    const pack = await loadEvidencePack(db, id);
    if (!pack) return null;
    const agency = await loadAgency(db, ctx.orgId);
    return { pack, org: agency.name, tz: agency.tz, personal: agency.personal };
  });
  if (!d) notFound();
  const { pack, tz, personal } = d;
  const today = dayInZone(tz);
  const ts = (v: string) => `${new Date(v).toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' })} (${tz})`;
  // In a personal workspace the authorization has its own title ("Authorization to obtain my own credit reports").
  const docTitle = (kind: string) => (isConsentKind(kind) ? consentTitle(kind, personal) : kind.replace(/_/g, ' '));
  const contract = [...pack.consents].reverse().find((c) => c.kind === 'croa_contract' && !c.revoked_at);
  const cancelNotices = pack.consents.filter((c) => /cancel/.test(c.kind));
  return (
    <div className="max-w-4xl">
      <PageHeader title="Evidence pack" back={{ href: `/app/clients/${id}?tab=billing`, label: pack.client.full_name }}
        subtitle={<>{pack.client.full_name}{pack.client.email ? ` · ${pack.client.email}` : ''} · client since {fmtDate(dayInZone(tz, new Date(pack.client.created_at)))} · {d.org}</>} actions={<PrintButton />} />
      <p className="mb-7 text-[0.8125rem] text-muted">Copied from this client’s records in {PRODUCT.name} on {fmtDate(today)}. Nothing is summarised or added. Where a person typed an entry in, the entry says so.</p>
      <div className="space-y-8">
        <Part title="Signed agreements and disclosures">
          {pack.consents.length === 0 ? <None>No signed agreement or disclosure is on record.</None> : (
            <div className="table-wrap"><table className="table"><thead><tr><th>Document</th><th>Version</th><th>Typed signature</th><th>Signed</th><th>IP address</th><th>Status</th></tr></thead>
              <tbody>{pack.consents.map((c, i) => {
                // How it was given: e-signed in the portal, on paper recorded by staff, or by the account holder of a personal workspace.
                const src = signatureSource(c, personal);
                return <tr key={i}>
                  <td className="font-medium">{docTitle(c.kind)}{c.has_text && <> · <a className="link font-normal" href={`/api/consents/${c.id}/pdf`}>{src === 'paper' ? 'app’s text when recorded (not a copy of the signed paper)' : src === 'self' ? 'copy of the text given' : 'copy of the signed text'}</a></>}</td>
                  <td>{c.version}</td>
                  <td>{c.signed_name}{src === 'paper' && <span className="block text-xs text-muted">signed on paper, recorded by staff</span>}{src === 'self' && <span className="block text-xs text-muted">given by the account holder in {PRODUCT.name}</span>}</td>
                  <td>{src === 'paper' ? <>{c.signed_on ? `On paper dated ${fmtDate(c.signed_on)}; ` : 'On paper; '}recorded {ts(c.signed_at)}</> : ts(c.signed_at)}</td>
                  <td>{src === 'paper' ? 'staff member’s (paper signature)' : c.ip ?? 'not recorded'}</td>
                  <td>{c.revoked_at ? `${c.revoked_reason === 'client_cancelled' ? 'Cancelled by the client in the portal' : 'Revoked'} ${ts(c.revoked_at)}` : 'In force'}</td></tr>;
              })}</tbody></table></div>)}
          {pack.consents.some((c) => signatureSource(c, personal) === 'paper' && c.has_text) && <p className="mt-1.5 text-muted">For a signature given on paper and recorded by staff, the text kept with the record is the agreement as it was in {PRODUCT.name} on the day it was recorded, dated with the date written on the paper. It is not a copy of the paper the client signed; the signed paper is the record of that.</p>}
          {personal && pack.consents.length > 0 && <p className="mt-1.5 text-muted">This is a personal workspace: what is on file was given by the account holder for their own file, in {PRODUCT.name}. No credit repair agreement applies.</p>}
        </Part>
        <Part title="Notice of cancellation">
          {personal ? <None>A personal workspace makes no service agreement, so no notice of cancellation applies.</None> : cancelNotices.length > 0
            ? <ul className="space-y-1">{cancelNotices.map((c, i) => <li key={i}>{docTitle(c.kind)}: acknowledged by “{c.signed_name}” on {ts(c.signed_at)}.</li>)}</ul>
            : contract?.has_text
              ? (contract.recorded_by
                ? <p>The service agreement in force was signed on paper and recorded by staff. The text kept with the record is the app’s text of the agreement on the day it was recorded, dated with the date written on the paper, which includes the Notice of Cancellation (15 U.S.C. § 1679e(b)) with the agency’s name, address and last day (counted from that date) filled in. It is not a copy of the paper the client signed.</p>
                : <p>The Notice of Cancellation (15 U.S.C. § 1679e(b)) is part of the service agreement in force: its exact text, with the agency’s name, address and the last day filled in, is stored with the signature, and the copy prints it twice.</p>)
              : <None>No separate acknowledgement of a notice of cancellation is on record for this client.</None>}
          {!personal && contract && (() => {
            // 15 U.S.C. § 1679e(a): cancellation is open until midnight of the 3rd business day after the contract is signed
            // (for a paper agreement, the date written on it). The same days the gate and the charge check use: the stored
            // ones, never shorter than counted again.
            const p = contractPeriod(contract, tz);
            const recorded = dayInZone(tz, new Date(contract.signed_at));
            const runs = p.endsOn >= today ? 'runs' : 'ran';
            return contract.recorded_by && recorded !== p.signedOn
              ? <p className="mt-1.5 text-muted">The service agreement in force was signed on paper on {sayDay(p.signedOn)} and recorded on {sayDay(recorded)}. Counting 3 business days from the date on the paper (weekends and federal holidays skipped), the cancellation period {runs} through {sayDay(p.endsOn)}.</p>
              : <p className="mt-1.5 text-muted">The service agreement in force was signed on {sayDay(p.signedOn)}. Counting 3 business days after signing (weekends and federal holidays skipped), the cancellation period {runs} through {sayDay(p.endsOn)}.</p>;
          })()}
        </Part>
        <Part title={`Letters sent (${pack.lettersSent.length})`}>
          {pack.lettersSent.length === 0 ? <None>No letter is recorded as sent.</None> : (
            <div className="table-wrap"><table className="table"><thead><tr><th>Sent</th><th>Letter</th><th>Recipient</th><th>Method</th><th>Tracking reference</th><th>Delivery record</th></tr></thead>
              <tbody>{pack.lettersSent.map((l, i) => <tr key={i}><td>{fmtDate(l.sent_on ?? (l.sent_at ? dayInZone(tz, new Date(l.sent_at)) : null))}</td><td className="font-medium">{l.title}</td><td>{l.recipient_name}</td><td>{l.sent_method ? METHOD[l.sent_method] ?? l.sent_method : 'not recorded'}</td><td>{l.tracking_number ?? 'none entered'}</td>
                <td>{l.delivery_source === 'carrier_confirmed' ? `Confirmed by carrier${l.carrier_delivered_at ? ` ${fmtDate(dayInZone(tz, new Date(l.carrier_delivered_at)))}` : ''}` : 'Recorded by staff; not confirmed by a carrier'}</td></tr>)}</tbody></table></div>)}
        </Part>
        <Part title={`Communications log (${pack.communicationsTotal})`}>
          {pack.communications.length === 0 ? <None>No message to or from the client is on record.</None> : (
            <>
              {pack.communicationsTotal > pack.communications.length && <p className="mb-2 text-muted">Showing the most recent {EVIDENCE_COMMS_LIMIT} of {pack.communicationsTotal}. The full log is on the client’s Messages tab.</p>}
              <div className="table-wrap"><table className="table"><thead><tr><th>When</th><th>Direction</th><th>Channel</th><th>Subject</th><th>Status</th></tr></thead>
                <tbody>{pack.communications.map((m, i) => <tr key={i}><td>{ts(m.created_at)}</td><td>{DIRECTION[m.direction] ?? m.direction}</td><td className="capitalize">{m.channel}</td><td>{m.subject ?? '—'}</td><td className="capitalize">{m.status}</td></tr>)}</tbody></table></div>
            </>)}
        </Part>
        <Part title={`Portal sign-ins (${pack.signIns.length})`}>
          {!pack.client.portal ? <None>This client has no portal account.</None> : pack.signIns.length === 0 ? <None>No portal sign-in is recorded.</None>
            : <ul className="columns-2 gap-8 text-muted sm:columns-3">{pack.signIns.map((s, i) => <li key={i}>{ts(s)}</li>)}</ul>}
        </Part>
        <Part title={`Payments recorded (${pack.payments.length})`}>
          {pack.payments.length === 0 ? <None>No payment is recorded.</None> : (
            <div className="table-wrap"><table className="table"><thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Status</th></tr></thead>
              <tbody>{pack.payments.map((p, i) => <tr key={i}><td>{fmtDate(dayInZone(tz, new Date(p.paid_at)))}</td><td className="tabular-nums">{money(p.amount_cents)}</td><td className="capitalize">{p.method}</td><td className="capitalize">{p.status}</td></tr>)}</tbody></table></div>)}
          <p className="mt-1.5 text-muted">Payments are entered by staff. {PRODUCT.name} does not process cards.</p>
        </Part>
      </div>
    </div>
  );
}
