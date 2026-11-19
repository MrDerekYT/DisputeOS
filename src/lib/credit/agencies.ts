/**
 * Registry of consumer reporting agencies a dispute can be sent to: the three nationwide credit bureaus and the
 * specialty agencies (bank account, public records, telecom and utilities, check verification, alternative credit).
 *
 * ACCURACY RULE for dispute addresses. A wrong mailing address sends a consumer's dispute nowhere, so an address is
 * stored here ONLY when it was read on an official page (the agency's own website, another nationwide bureau's or the
 * CFPB's), together with the page it was read on and the date it was read. Where nobody has confirmed a dispute
 * mailing address at its source, `disputeAddress` is null: the app then asks staff to type the address from the
 * agency's current instructions and never prefills a guess. Re-verify before changing anything, and update
 * `verifiedOn` when you do. Enforced by tests/unit/specialty-agencies.test.ts.
 *
 * What was confirmed in the review of 2026-11-19, and what was not:
 *  - Experian, Equifax and TransUnion: all three addresses are printed on Experian's page cited below; TransUnion's is
 *    also on its own dispute-by-mail page. Equifax's own page was not readable, so its entry cites Experian's page.
 *  - ChexSystems, Early Warning and NCTUE: the cited pages were opened in review (their mailing requirements below
 *    are quoted from them).
 *  - LexisNexis: its page could not be opened in review, so it carries no address. Staff type it.
 *
 * Nothing here is a data feed. No agency in this file sends the app any data; reports are requested by the consumer
 * and items are typed in by a person.
 */
import { BUREAU_ADDRESSES } from '../disputes/workflow';

type Lang = 'en' | 'es';

export const AGENCY_KINDS = ['credit_bureau', 'bank_account', 'public_records', 'telecom_utilities', 'check_verification', 'alternative_credit'] as const;
export type AgencyKind = (typeof AGENCY_KINDS)[number];
export const AGENCY_KIND_LABEL: Record<AgencyKind, Record<Lang, string>> = {
  credit_bureau: { en: 'Credit bureau', es: 'Agencia de crédito' },
  bank_account: { en: 'Bank account reporting', es: 'Historial de cuentas bancarias' },
  public_records: { en: 'Background and public records', es: 'Antecedentes y registros públicos' },
  telecom_utilities: { en: 'Telecom and utilities', es: 'Telefonía y servicios públicos' },
  check_verification: { en: 'Check verification', es: 'Verificación de cheques' },
  alternative_credit: { en: 'Alternative credit', es: 'Crédito alternativo' },
};

export interface AgencyAddress {
  /** The lines under the addressee (the agency's `name`), as printed on the source page. */
  lines: string[];
  /** The official page the address was read on. */
  sourceUrl: string;
  /** The day it was read there (YYYY-MM-DD). */
  verifiedOn: string;
}

export interface Agency {
  key: string;
  name: string;
  /** Short name for labels and lists. */
  shortName: string;
  kind: AgencyKind;
  /** True for the three nationwide bureaus, whose reports the app imports and compares. Everything else is entered by hand. */
  nationwide: boolean;
  /** What the agency reports, in one sentence. */
  reports: Record<Lang, string>;
  /** How a consumer requests their free file disclosure. */
  disclosure: { url: string; how: Record<Lang, string> };
  disputeAddress: AgencyAddress | null;
  /** The agency's own page for disputing online (or its dispute instructions when there is no online form). */
  onlineDisputeUrl: string | null;
  /**
   * What the agency's own page says a mailed dispute must carry, for staff (English). Null where no page was read: the
   * screens then only link to the agency's instructions.
   */
  mailRequirements: { text: string; sourceUrl: string; verifiedOn: string } | null;
  /** What the letter itself must state for this agency, beyond name and address. Missing ones become [… NEEDED] lines a person completes. */
  letterNeeds: readonly LetterNeed[];
  /**
   * The general FCRA reinvestigation window, counted from receipt (45 when the consumer sends more information during it).
   * Not an agency-specific promise: state law can shorten it.
   */
  reinvestigationDays: 30;
}

export type LetterNeed = 'dob' | 'ssn' | 'consumer_id';

const VERIFIED = '2026-11-19';
const EXPERIAN_PAGE = 'https://www.experian.com/blogs/ask-experian/credit-education/faqs/how-to-dispute-credit-report-information/';
const NONE = { mailRequirements: null, letterNeeds: [] } as const;
const ACR = { url: 'https://www.annualcreditreport.com', how: { en: 'Request it free at AnnualCreditReport.com, the official site for all three bureaus.', es: 'Pídalo gratis en AnnualCreditReport.com, el sitio oficial de las tres agencias.' } };
const bureauLines = (key: string) => BUREAU_ADDRESSES[key]!.address.split(/,\s*(?=[A-Z][a-z])/);

export const AGENCIES: Agency[] = [
  // ---- The three nationwide bureaus. Names and addresses are the existing ones in src/lib/disputes/workflow.ts, unchanged.
  //      Each `sourceUrl` is a page that prints that address and was opened on the date shown (see the note at the top).
  {
    key: 'experian', name: BUREAU_ADDRESSES.experian!.name, shortName: 'Experian', kind: 'credit_bureau', nationwide: true,
    reports: { en: 'Credit accounts, payment history, collections, public records and inquiries.', es: 'Cuentas de crédito, historial de pagos, cobranzas, registros públicos y consultas.' },
    disclosure: ACR,
    disputeAddress: { lines: bureauLines('experian'), sourceUrl: EXPERIAN_PAGE, verifiedOn: VERIFIED },
    onlineDisputeUrl: 'https://www.experian.com/help/dispute-credit/', reinvestigationDays: 30, ...NONE,
  },
  {
    key: 'equifax', name: BUREAU_ADDRESSES.equifax!.name, shortName: 'Equifax', kind: 'credit_bureau', nationwide: true,
    reports: { en: 'Credit accounts, payment history, collections, public records and inquiries.', es: 'Cuentas de crédito, historial de pagos, cobranzas, registros públicos y consultas.' },
    disclosure: ACR,
    disputeAddress: { lines: bureauLines('equifax'), sourceUrl: EXPERIAN_PAGE, verifiedOn: VERIFIED },
    onlineDisputeUrl: 'https://www.equifax.com/personal/credit-report-services/credit-dispute/', reinvestigationDays: 30, ...NONE,
  },
  {
    key: 'transunion', name: BUREAU_ADDRESSES.transunion!.name, shortName: 'TransUnion', kind: 'credit_bureau', nationwide: true,
    reports: { en: 'Credit accounts, payment history, collections, public records and inquiries.', es: 'Cuentas de crédito, historial de pagos, cobranzas, registros públicos y consultas.' },
    disclosure: ACR,
    disputeAddress: { lines: bureauLines('transunion'), sourceUrl: 'https://www.transunion.com/credit-disputes/dispute-your-credit/mail-or-phone', verifiedOn: VERIFIED },
    onlineDisputeUrl: 'https://www.transunion.com/credit-disputes/dispute-your-credit', reinvestigationDays: 30, ...NONE,
  },

  // ---- Specialty agencies. Keys must match the disputes_agency_check constraint (db/migrations/0017_specialty_agencies.sql).
  {
    key: 'chexsystems', name: 'Chex Systems, Inc.', shortName: 'ChexSystems', kind: 'bank_account', nationwide: false,
    reports: {
      en: 'Checking and savings accounts that a bank or credit union closed and reported, along with inquiries and check orders.',
      es: 'Cuentas de cheques y de ahorros que un banco o cooperativa de crédito cerró y reportó, además de consultas y pedidos de cheques.',
    },
    disclosure: {
      url: 'https://www.chexsystems.com/request-reports/consumer-disclosure',
      how: { en: 'Request the free Consumer Disclosure on the ChexSystems website, by phone or by mail.', es: 'Pida el informe gratuito (Consumer Disclosure) en el sitio de ChexSystems, por teléfono o por correo.' },
    },
    disputeAddress: {
      lines: ['Attn: Consumer Relations', 'PO Box 583399', 'Minneapolis, MN 55458'],
      sourceUrl: 'https://www.chexsystems.com/dispute', verifiedOn: VERIFIED,
    },
    onlineDisputeUrl: 'https://www.chexsystems.com/dispute', reinvestigationDays: 30,
    mailRequirements: {
      text: 'ChexSystems asks you to mail “the completed Request for Reinvestigation Form along with authentication documents”. Correspondence “must include consumer’s full name, current address, date of birth, Social Security number”. The documents it lists are a colour copy of the front and back of a photo ID, the Social Security card, and a proof of address dated within the last 90 days.',
      sourceUrl: 'https://www.chexsystems.com/dispute', verifiedOn: VERIFIED,
    },
    letterNeeds: ['dob', 'ssn'],
  },
  {
    key: 'early_warning', name: 'Early Warning Services, LLC', shortName: 'Early Warning', kind: 'bank_account', nationwide: false,
    reports: {
      en: 'Checking and savings account history and activity reported by banks and credit unions.',
      es: 'Historial y actividad de cuentas de cheques y de ahorros reportados por bancos y cooperativas de crédito.',
    },
    disclosure: {
      url: 'https://www.earlywarning.com/consumer-information',
      how: { en: 'Request the free file disclosure through the Early Warning consumer page.', es: 'Pida el informe gratuito (file disclosure) en la página para consumidores de Early Warning.' },
    },
    disputeAddress: {
      lines: ['Attn: Consumer Services', '5801 N Pima Road', 'Scottsdale, Arizona 85250'],
      sourceUrl: 'https://www.earlywarning.com/dispute-file-disclosure', verifiedOn: VERIFIED,
    },
    onlineDisputeUrl: 'https://www.earlywarning.com/dispute-file-disclosure', reinvestigationDays: 30,
    mailRequirements: {
      text: 'Early Warning says a dispute must include “Your consumer ID number, found on the first page of your file disclosure”.',
      sourceUrl: 'https://www.earlywarning.com/dispute-file-disclosure', verifiedOn: VERIFIED,
    },
    letterNeeds: ['consumer_id'],
  },
  {
    key: 'lexisnexis', name: 'LexisNexis Risk Solutions Consumer Center', shortName: 'LexisNexis', kind: 'public_records', nationwide: false,
    reports: {
      en: 'Public records and other data such as property ownership, liens, judgments, bankruptcies, professional licenses and past addresses.',
      es: 'Registros públicos y otros datos, como propiedad de inmuebles, gravámenes, sentencias, bancarrotas, licencias profesionales y direcciones anteriores.',
    },
    disclosure: {
      url: 'https://consumer.risk.lexisnexis.com/consumer',
      how: { en: 'Request the free Consumer Disclosure Report online, by mail or by phone.', es: 'Pida el informe gratuito (Consumer Disclosure Report) en línea, por correo o por teléfono.' },
    },
    // No address is stored: the LexisNexis consumer pages could not be opened when this file was reviewed (2026-11-19),
    // so nobody confirmed one at its source. Staff type it from the instructions that come with the consumer's report.
    disputeAddress: null,
    onlineDisputeUrl: 'https://consumer.risk.lexisnexis.com/consumer', reinvestigationDays: 30, ...NONE,
  },
  {
    key: 'innovis', name: 'Innovis', shortName: 'Innovis', kind: 'credit_bureau', nationwide: false,
    reports: { en: 'Credit and identity verification data, kept separately from the three nationwide bureaus.', es: 'Datos de crédito y de verificación de identidad, aparte de las tres agencias nacionales.' },
    disclosure: {
      url: 'https://www.innovis.com/personal/creditReport',
      how: { en: 'Order the free Innovis Credit Report on the Innovis website.', es: 'Pida el informe de crédito gratuito de Innovis en su sitio web.' },
    },
    // Innovis takes mailed disputes on its own form; the dispute page read on 2026-11-19 does not print the mailing address.
    disputeAddress: null,
    onlineDisputeUrl: 'https://www.innovis.com/personal/disputeResolution', reinvestigationDays: 30, ...NONE,
  },
  {
    key: 'nctue', name: 'National Consumer Telecom & Utilities Exchange (NCTUE)', shortName: 'NCTUE', kind: 'telecom_utilities', nationwide: false,
    reports: {
      en: 'Telecommunications, pay TV and utility accounts: account history, unpaid closed accounts and service applications.',
      es: 'Cuentas de telefonía, televisión de paga y servicios públicos: historial, cuentas cerradas con saldo pendiente y solicitudes de servicio.',
    },
    disclosure: {
      url: 'https://nctue.com/consumer/',
      how: { en: 'Request the free NCTUE Disclosure Report through the NCTUE consumer portal, by phone or by mail.', es: 'Pida el informe gratuito de NCTUE en su portal para consumidores, por teléfono o por correo.' },
    },
    disputeAddress: {
      lines: ['Disputes & Fraud', 'Exchange Service Center – NCTUE', 'P.O. Box 105398', 'Atlanta, GA 30348'],
      sourceUrl: 'https://nctue.com/consumer/', verifiedOn: VERIFIED,
    },
    onlineDisputeUrl: 'https://nctue.com/consumer/', reinvestigationDays: 30,
    mailRequirements: {
      text: 'NCTUE asks: “Please include your name, address, Social Security number, and date of birth.”',
      sourceUrl: 'https://nctue.com/consumer/', verifiedOn: VERIFIED,
    },
    letterNeeds: ['dob', 'ssn'],
  },
  {
    key: 'telecheck', name: 'TeleCheck Services, Inc.', shortName: 'TeleCheck', kind: 'check_verification', nationwide: false,
    reports: { en: 'Check writing and checking account information used by merchants and banks when they accept a check or open an account.', es: 'Información sobre cheques emitidos y cuentas de cheques que usan comercios y bancos al aceptar un cheque o abrir una cuenta.' },
    disclosure: {
      url: 'https://getassistance.telecheck.com/consumer-file-report/',
      how: { en: 'Request the free Consumer File Report on the TeleCheck assistance site.', es: 'Pida el informe gratuito (Consumer File Report) en el sitio de asistencia de TeleCheck.' },
    },
    // TeleCheck takes mailed disputes on its own form; the dispute page read on 2026-11-19 does not print the mailing address.
    disputeAddress: null,
    onlineDisputeUrl: 'https://getassistance.telecheck.com/information-dispute/', reinvestigationDays: 30, ...NONE,
  },
  {
    key: 'clarity', name: 'Clarity Services, Inc.', shortName: 'Clarity Services', kind: 'alternative_credit', nationwide: false,
    reports: {
      en: 'Payday, installment and other short-term loans, rent-to-own and similar accounts that often do not appear on the three main credit reports.',
      es: 'Préstamos de día de pago, a plazos y otros de corto plazo, alquiler con opción de compra y cuentas similares que a menudo no aparecen en los tres informes principales.',
    },
    disclosure: {
      url: 'https://www.clarityservices.com/support/file-disclosure/',
      how: { en: 'Request the free Clarity Report on the Clarity Services consumer site.', es: 'Pida el informe gratuito de Clarity en el sitio para consumidores de Clarity Services.' },
    },
    // The Clarity pages read on 2026-11-19 give a consumer support mailing address but do not say disputes go there.
    disputeAddress: null,
    onlineDisputeUrl: null, reinvestigationDays: 30, ...NONE,
  },
];

export const agencyByKey = (key: string | null | undefined): Agency | undefined => (key ? AGENCIES.find((a) => a.key === key) : undefined);
/** The agencies whose items are entered by hand (everything except the three nationwide bureaus). */
export const SPECIALTY_AGENCIES: Agency[] = AGENCIES.filter((a) => !a.nationwide);
export const SPECIALTY_KEYS: string[] = SPECIALTY_AGENCIES.map((a) => a.key);
export const specialtyAgency = (key: string | null | undefined): Agency | undefined => SPECIALTY_AGENCIES.find((a) => a.key === key);
/** The address block for a letter, or null when none is verified. */
export const addressBlock = (a: Agency | undefined): string | null => (a?.disputeAddress ? a.disputeAddress.lines.join('\n') : null);

// ---------------------------------------------------------------- the item, as a person copied it from the disclosure
export interface AgencyItem {
  /** Company or account name as it appears on the disclosure. */
  name: string;
  /** Reference or masked number. Never a full account number. */
  reference?: string | null;
  /** The date shown for the item, as printed. */
  date?: string | null;
  /** The amount shown, as printed (e.g. "$312.40"). */
  amount?: string | null;
  /** The consumer's ID or file number printed on the disclosure, when the agency gives one. It identifies the consumer, not the item. */
  consumerId?: string | null;
}

export function parseAgencyItem(v: unknown): AgencyItem | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === 'string' && (o[k] as string).trim() ? (o[k] as string).trim() : null);
  const name = s('name');
  return name ? { name, reference: s('reference'), date: s('date'), amount: s('amount'), consumerId: s('consumerId') } : null;
}

const ITEM_LABELS: Record<Lang, [string, string, string, string]> = {
  en: ['Company or account name', 'Reference or masked number', 'Date shown', 'Amount shown'],
  es: ['Nombre de la empresa o cuenta', 'Referencia o número parcial', 'Fecha indicada', 'Monto indicado'],
};
/** The item as lines for a letter: only the fields a person entered, nothing inferred. */
export function agencyItemLines(item: AgencyItem, lang: Lang): string[] {
  const l = ITEM_LABELS[lang];
  return [[l[0], item.name], [l[1], item.reference], [l[2], item.date], [l[3], item.amount]].filter(([, v]) => v).map(([k, v]) => `  ${k}: ${v}`);
}

const NEED_LABEL: Record<LetterNeed, Record<Lang, string>> = {
  consumer_id: { en: 'Consumer ID or file number', es: 'Número de identificación del consumidor o de expediente' },
  dob: { en: 'Date of birth', es: 'Fecha de nacimiento' },
  ssn: { en: 'Social Security number', es: 'Número de Seguro Social' },
};
const NEED_MARK: Record<LetterNeed, string> = { consumer_id: '[CONSUMER ID NEEDED]', dob: '[DATE OF BIRTH NEEDED]', ssn: '[SOCIAL SECURITY NUMBER NEEDED]' };
/**
 * The identification lines a specialty letter carries under the sender's address. A consumer ID that was entered is
 * printed. Anything else the agency's page says the letter must state is left as a [… NEEDED] line: the app never
 * fills in a date of birth or a Social Security number, a person types it, and the letter cannot be approved before.
 */
export function agencyIdentityLines(agency: Agency | undefined, item: AgencyItem | null | undefined, lang: Lang): string[] {
  if (!agency) return [];
  const out: string[] = [];
  if (item?.consumerId) out.push(`${NEED_LABEL.consumer_id[lang]}: ${item.consumerId}`);
  for (const n of agency.letterNeeds) if (!(n === 'consumer_id' && item?.consumerId)) out.push(`${NEED_LABEL[n][lang]}: ${NEED_MARK[n]}`);
  return out;
}

// ---------------------------------------------------------------- which reports a client has asked for
export const SPECIALTY_REPORT_STATUSES = ['not_requested', 'requested', 'received'] as const;
export type SpecialtyReportStatus = (typeof SPECIALTY_REPORT_STATUSES)[number];
export interface SpecialtyReportState { status: SpecialtyReportStatus; on: string | null; documentId: string | null }

/** Reads clients.specialty_reports. Anything missing or malformed reads as "not requested". */
export function specialtyReportStates(raw: unknown): Record<string, SpecialtyReportState> {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, SpecialtyReportState> = {};
  for (const a of SPECIALTY_AGENCIES) {
    const v = o[a.key] as { status?: unknown; on?: unknown; document_id?: unknown } | undefined;
    const status = v?.status === 'requested' || v?.status === 'received' ? v.status : 'not_requested';
    out[a.key] = {
      status,
      on: status !== 'not_requested' && typeof v?.on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.on) ? v.on : null,
      documentId: status === 'received' && typeof v?.document_id === 'string' ? v.document_id : null,
    };
  }
  return out;
}

/** The two reports the plan suggests when the agency has marked a banking or background concern. */
export const CONCERN_AGENCIES = ['chexsystems', 'lexisnexis'] as const;
