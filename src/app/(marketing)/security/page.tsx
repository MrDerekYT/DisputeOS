import Link from 'next/link';
import type { Metadata } from 'next';
import { Band, CtaBand, JsonLd, PageIntro } from '@/components/marketing-site';
import { PRODUCT } from '@/lib/product';
import { breadcrumbLd, pageMeta } from '@/lib/site';

export const generateMetadata = (): Metadata => pageMeta({
  title: `Security: How Client Data Is Protected | ${PRODUCT.name}`,
  description: 'Tenant isolation enforced by PostgreSQL row-level security, encrypted documents and identifiers, two-step verification, an append-only audit log, and a plain list of what has not been audited.',
  path: '/security',
});

const GROUPS: { title: string; lede: string; items: [string, string][] }[] = [
  {
    title: 'Who can see what.',
    lede: 'Separation between agencies, and between clients, is enforced by the database rather than left to application code alone.',
    items: [
      ['Row-level security on every table', 'Each request runs under a restricted database role with the signed-in user attached, so PostgreSQL itself refuses rows that belong to another agency.'],
      ['Clients see only their own record', 'Portal access is tied to the client’s own account. In the portal a client can change only their phone, address and language.'],
      ['Roles for staff', 'Owner, admin, manager and specialist each have a defined set of permissions. Nobody can make themselves an owner, and admins cannot create other admins.'],
    ],
  },
  {
    title: 'Signing in.',
    lede: 'Accounts are first-party: there is no third-party login to depend on.',
    items: [
      ['Two-step verification', 'Authenticator-app codes (TOTP) for staff, required in production. A code cannot be used twice.'],
      ['Passwords and lockout', 'Passwords are hashed with scrypt. An account locks after five failed attempts, and sign-in, sign-up and reset are rate limited per address and per email.'],
      ['Sessions you can end', 'Sessions are random tokens stored only as a hash, with idle and absolute expiry. Changing or resetting a password signs out every session.'],
    ],
  },
  {
    title: 'Stored data.',
    lede: 'The most sensitive fields are encrypted individually, and some are never stored at all.',
    items: [
      ['Encrypted identifiers and files', 'Social Security numbers, dates of birth and every uploaded file are encrypted with AES-256-GCM, with support for rotating the key.'],
      ['Account numbers are not kept', 'Only the last four digits of an account number are stored.'],
      ['Upload checks', 'A file’s type is read from its contents, not its name, and uploads are capped at 10 MB. Downloads are served so a browser will not run them.'],
      ['Export and deletion', 'One client’s data can be exported as JSON, or deleted permanently after a typed confirmation.'],
    ],
  },
  {
    title: 'A record of what happened.',
    lede: 'When a client or a regulator asks who did what, the answer is already written down.',
    items: [
      ['Append-only audit log', 'Entries cannot be edited or deleted, even by the application’s own privileged connection. Personal details are kept out of log metadata.'],
      ['Consent ledger', 'Each signed disclosure, contract and authorization is stored with its version, a hash of the text shown, the time and the address it came from.'],
      ['Approval before anything goes out', 'A letter needs a manager’s approval of its exact text. The product never mails or emails a dispute itself; a person sends it and records that they did.'],
    ],
  },
  {
    title: 'In the browser, and with AI.',
    lede: 'Standard web protections, and a narrow path for anything sent to an AI provider.',
    items: [
      ['Strict content security policy', 'Scripts run only with a per-request nonce, pages cannot be framed by other sites, and connections are upgraded to HTTPS.'],
      ['Identifiers stripped before AI', 'Personal identifiers are removed before any text leaves the server for an AI provider. AI is optional, and the product works without it.'],
      ['AI output is checked', 'A suggestion is discarded if it changes a number or a date, or contains a guarantee or other blocked claim.'],
    ],
  },
];

const NOT_DONE: [string, string][] = [
  ['No SOC 2 audit or formal penetration test', 'Neither has been carried out. The controls on this page are covered by automated tests, not by an outside auditor.'],
  ['No malware scanning of uploads', 'Files are type-checked and stored encrypted, but they are not scanned for malware.'],
  ['No recovery codes', 'If a team member loses their authenticator, an admin resets it for them. An owner’s cannot be reset this way.'],
  ['Not legal advice', `${PRODUCT.name} enforces workflow rules that follow from CROA and the FCRA. It cannot determine whether your business is compliant, and the consent documents it ships with are reference drafts for your attorney to review.`],
];

export default function SecurityPage() {
  return (
    <>
      <PageIntro title="Client files are sensitive. Here is exactly how they are handled."
        lede={`${PRODUCT.name} holds credit reports, identity details and signed agreements. This page lists the protections that are built, and the things that have not been done yet.`} />

      {GROUPS.map((g) => (
        <Band key={g.title} title={g.title} lede={g.lede}>
          <dl className="grid gap-x-12 gap-y-8 md:grid-cols-2 lg:grid-cols-3">
            {g.items.map(([t, b]) => (
              <div key={t}>
                <dt className="font-semibold">{t}</dt>
                <dd className="mt-1.5 text-[0.9375rem] leading-relaxed text-muted">{b}</dd>
              </div>
            ))}
          </dl>
        </Band>
      ))}

      <Band id="not-done" title="What has not been done." lede="Listed here so you can weigh them before you rely on the product.">
        <ul className="grid gap-x-12 gap-y-5 md:grid-cols-2">
          {NOT_DONE.map(([t, b]) => <li key={t} className="border-t border-line pt-4"><span className="font-semibold">{t}.</span> <span className="text-muted">{b}</span></li>)}
        </ul>
        <p className="mt-8"><Link href="/features#manual" className="link">What your team still does by hand</Link></p>
      </Band>

      <CtaBand />
      <JsonLd data={breadcrumbLd([{ name: 'Home', path: '/' }, { name: 'Security', path: '/security' }])} />
    </>
  );
}
