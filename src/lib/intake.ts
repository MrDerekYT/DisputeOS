/**
 * The identity documents a credit bureau normally asks for with a dispute sent by mail, and where one client stands on
 * each. This is the single definition: the portal checklist, the staff "Intake documents" block, the client plan, the
 * warning before a dispute is recorded as sent and the "Enclose with this letter" list all read it.
 *
 * Sources (the bureaus' own instructions, as recorded when this was written on 2026-11-19). NOT RE-CONFIRMED: in the
 * review of the same day the TransUnion and Equifax pages below timed out or could not be read, so the "two months"
 * rule in particular rests on the first reading only. Have a person open the TransUnion page once and correct
 * ADDRESS_PROOF_MAX_AGE_DAYS and the wording here if it says something else. Until then the rule is only ever shown
 * as advice ("if you can"), and nothing is blocked on it.
 *  - Equifax, "What documentation should I send in to validate my ID or address?" — one item to validate identity and
 *    one to validate address, with the accepted documents listed:
 *    https://www.equifax.com/personal/help/article-list/-/h/a/documentation-validate-id-address-credit-file-assistance/
 *  - Equifax dispute request form — proof of identity "must contain your SSN" (Social Security card, pay stub with SSN,
 *    W-2 or 1099); proof of address "must contain your current mailing address"; asks for legible, enlarged copies
 *    without highlighting: https://assets.equifax.com/assets/personal/Dispute.pdf
 *  - Experian, instructions for disputing by mail — a copy of a government-issued identification card and a copy of a
 *    utility bill, bank or insurance statement; copies only, never originals:
 *    https://www.experian.com/blogs/ask-experian/wp-content/themes/exp/pdf/dispute-form.pdf
 *    https://www.experian.com/help/dispute-credit/
 *  - TransUnion, "What information do you need to confirm my address?" and the request-by-mail table — bank statements
 *    and utility bills "not older than two months", licences and ID cards "current and unexpired", statements printed
 *    from a website not accepted as proof of address; identity proof such as a Social Security card or a letter from
 *    the Social Security Administration: https://www.transunion.com/customer-support/faqs/support
 *    https://www.transunion.com/extended-fraud-alert
 *  - Identity theft: an FTC identity theft report or a police report (Equifax form above; TransUnion,
 *    https://www.transunion.com/blog/credit-advice/how-to-dispute-your-credit-report).
 *
 * Only TransUnion states an age limit for a proof of address (two months). Equifax says "recent" and Experian gives no
 * number, so the wording shown to people is "recent", with two months given as the safe choice, and a proof of address
 * is only called out of date when a reviewer recorded its date and it is past ADDRESS_PROOF_MAX_AGE_DAYS.
 *
 * Nothing here is required by law to dispute: a consumer may dispute without these, and the bureau may then ask for
 * them. That is why a missing item produces a warning before sending, never a block.
 */

export type IntakeLang = 'en' | 'es';
type Text = Record<IntakeLang, string>;

export interface IntakeItem {
  /** Also the document kind (public.documents.kind) an upload for this item is stored under. */
  key: string;
  label: Text;
  /** What counts, in one sentence. */
  accepts: Text;
  tips: Text[];
  /** One line for staff only. */
  staffNote?: string;
}

/** TransUnion: bank statements and utility bills "not older than two months" (source above; not re-confirmed in review, see the note there). */
export const ADDRESS_PROOF_MAX_AGE_DAYS = 60;

const CORNERS: Text = { en: 'Show the whole page or card: all four corners visible, nothing cut off, easy to read.', es: 'Muestre la página o tarjeta completa: las cuatro esquinas visibles, nada cortado y fácil de leer.' };

export const INTAKE_REQUIRED: IntakeItem[] = [
  {
    key: 'id',
    label: { en: 'Government-issued photo ID', es: 'Identificación oficial con foto' },
    accepts: { en: 'A driver’s license, state ID card, passport or military ID.', es: 'Licencia de conducir, identificación estatal, pasaporte o identificación militar.' },
    tips: [
      CORNERS,
      { en: 'It must be current, not expired.', es: 'Debe estar vigente, no vencida.' },
      { en: 'The name should match the name on your credit report.', es: 'El nombre debe coincidir con el de su informe de crédito.' },
    ],
  },
  {
    key: 'proof_of_address',
    label: { en: 'Proof of current address', es: 'Comprobante de domicilio actual' },
    accepts: {
      en: 'A recent utility or phone bill, bank or insurance statement, lease or mortgage statement that shows your name and current address.',
      es: 'Un recibo reciente de servicios o teléfono, un estado de cuenta bancario o de seguro, o un contrato de alquiler o estado de hipoteca con su nombre y domicilio actual.',
    },
    tips: [
      CORNERS,
      { en: 'Recent means dated within the last two months if you can.', es: 'Reciente significa, si es posible, con fecha de los últimos dos meses.' },
      { en: 'Your name and address must match what you want on your credit report.', es: 'Su nombre y domicilio deben coincidir con lo que quiere que aparezca en su informe de crédito.' },
      { en: 'Send the statement that was mailed to you, or the PDF from your provider, rather than a screenshot of a web page.', es: 'Envíe el estado de cuenta que recibió por correo o el PDF de su proveedor, no una captura de pantalla de una página web.' },
    ],
  },
  {
    key: 'ssn_proof',
    label: { en: 'Proof of Social Security number', es: 'Comprobante de número de Seguro Social' },
    accepts: {
      en: 'Your Social Security card, or an official document that shows your full number: a W-2, a 1099, a pay stub or a letter from the Social Security Administration.',
      es: 'Su tarjeta de Seguro Social o un documento oficial que muestre su número completo: un formulario W-2 o 1099, un talón de pago o una carta de la Administración del Seguro Social.',
    },
    tips: [
      CORNERS,
      { en: 'The name should match the name on your credit report.', es: 'El nombre debe coincidir con el de su informe de crédito.' },
    ],
    staffNote: 'Shows a full Social Security number. Enclose it only when the bureau’s instructions call for it.',
  },
];

/** Never required and never counted as missing: each is shown as "only if this applies". */
export const INTAKE_OPTIONAL: IntakeItem[] = [
  {
    key: 'previous_address',
    label: { en: 'Proof of a previous address', es: 'Comprobante de un domicilio anterior' },
    accepts: { en: 'Only if you moved in the last two years: a bill or statement that shows your name at the earlier address.', es: 'Solo si se mudó en los últimos dos años: un recibo o estado de cuenta con su nombre en el domicilio anterior.' },
    tips: [CORNERS],
  },
  {
    key: 'name_change',
    label: { en: 'Name change document', es: 'Documento de cambio de nombre' },
    accepts: { en: 'Only if your name has changed: a marriage certificate, divorce decree or court order.', es: 'Solo si cambió de nombre: acta de matrimonio, sentencia de divorcio u orden judicial.' },
    tips: [CORNERS],
  },
  {
    key: 'ftc_report',
    label: { en: 'Identity theft report', es: 'Informe de robo de identidad' },
    accepts: { en: 'Only if you were a victim of identity theft: the report you filed at IdentityTheft.gov.', es: 'Solo si fue víctima de robo de identidad: el informe que presentó en RobodeIdentidad.gov.' },
    tips: [{ en: 'Include every page of the report.', es: 'Incluya todas las páginas del informe.' }],
  },
  {
    key: 'police_report',
    label: { en: 'Police report', es: 'Informe policial' },
    accepts: { en: 'Only if you reported identity theft to the police.', es: 'Solo si denunció el robo de identidad ante la policía.' },
    tips: [{ en: 'Include every page of the report.', es: 'Incluya todas las páginas del informe.' }],
  },
  {
    key: 'power_of_attorney',
    label: { en: 'Power of attorney', es: 'Poder notarial' },
    accepts: { en: 'Only if someone acts for you under a power of attorney: the signed document.', es: 'Solo si alguien actúa en su nombre con un poder notarial: el documento firmado.' },
    tips: [CORNERS],
  },
];

export const INTAKE_ITEMS: IntakeItem[] = [...INTAKE_REQUIRED, ...INTAKE_OPTIONAL];
export const intakeItem = (key: string): IntakeItem | undefined => INTAKE_ITEMS.find((i) => i.key === key);

/** The columns of public.documents the status is computed from. */
export interface IntakeDoc {
  id: string; kind: string; file_name: string; review_status: string; review_note: string | null;
  /** Date printed on the document (YYYY-MM-DD), when a reviewer recorded it. */
  doc_date: string | null;
  /** Expiry date (YYYY-MM-DD), when a reviewer recorded it. */
  expires_on: string | null;
  created_at: string | Date;
}

/** `stale` covers both an expired ID and a proof of address that is no longer recent; `why` says which. */
export type IntakeState = 'missing' | 'pending' | 'accepted' | 'rejected' | 'stale';
export interface IntakeStatus {
  item: IntakeItem;
  state: IntakeState;
  /** The document the state is about (none when missing). */
  doc: IntakeDoc | null;
  why?: 'expired' | 'old';
  /** The reviewer's reason, when rejected. */
  reason?: string;
}

const day = (d: string | Date) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Why an accepted document can no longer be relied on today, or null. Only ever says so from a recorded date. */
export function staleReason(doc: IntakeDoc, today: string): 'expired' | 'old' | null {
  if (doc.expires_on && day(doc.expires_on) < today) return 'expired';
  if (doc.kind === 'proof_of_address' && doc.doc_date && daysBetween(day(doc.doc_date), today) > ADDRESS_PROOF_MAX_AGE_DAYS) return 'old';
  return null;
}

/**
 * Where a client stands on each item, from their real documents only. `today` is the agency's calendar day (YYYY-MM-DD).
 * Per item: an accepted document that is still good wins; otherwise one awaiting review; otherwise the newest document
 * decides (rejected, or accepted but expired / no longer recent); with no document at all the item is missing.
 */
export function intakeStatus(docs: IntakeDoc[], today: string, items: IntakeItem[] = INTAKE_REQUIRED): IntakeStatus[] {
  return items.map((item) => {
    const mine = docs.filter((d) => d.kind === item.key).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const good = mine.find((d) => d.review_status === 'accepted' && !staleReason(d, today));
    if (good) return { item, state: 'accepted', doc: good };
    const pending = mine.find((d) => d.review_status === 'pending_review');
    if (pending) return { item, state: 'pending', doc: pending };
    const newest = mine[0];
    if (!newest) return { item, state: 'missing', doc: null };
    if (newest.review_status === 'rejected') return { item, state: 'rejected', doc: newest, reason: newest.review_note ?? undefined };
    return { item, state: 'stale', doc: newest, why: staleReason(newest, today) ?? undefined };
  });
}

export interface IntakeSummary {
  total: number;
  accepted: number;
  /** Uploaded and either accepted or waiting for review: what the client has done. */
  provided: number;
  /** Items the client still has to send (missing, rejected, expired or no longer recent). */
  needed: IntakeStatus[];
  /** Items that are not accepted yet, whoever has to act next. */
  notAccepted: IntakeStatus[];
  complete: boolean;
}

export function intakeSummary(statuses: IntakeStatus[]): IntakeSummary {
  const accepted = statuses.filter((s) => s.state === 'accepted').length;
  const pending = statuses.filter((s) => s.state === 'pending').length;
  return {
    total: statuses.length, accepted, provided: accepted + pending,
    needed: statuses.filter((s) => s.state === 'missing' || s.state === 'rejected' || s.state === 'stale'),
    notAccepted: statuses.filter((s) => s.state !== 'accepted'),
    complete: accepted === statuses.length,
  };
}

/** Staff wording for a state. The portal has its own strings in portal-i18n. */
export function intakeStateLabel(s: IntakeStatus): string {
  switch (s.state) {
    case 'accepted': return 'Accepted';
    case 'pending': return 'Uploaded, awaiting review';
    case 'rejected': return 'Rejected';
    case 'stale': return s.why === 'expired' ? 'Expired' : 'No longer recent';
    default: return 'Missing';
  }
}
