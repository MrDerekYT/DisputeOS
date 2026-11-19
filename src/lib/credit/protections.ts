/**
 * "Protect your file": what a consumer can place or request on their own file, agency by agency. Security freezes,
 * fraud alerts, opt-outs, consumer statements and file disclosures.
 *
 * THE CONSUMER DOES THESE PERSONALLY. Nothing in this file is submitted by the software or by the agency's staff, and
 * no agency login, PIN or password is ever collected. A security freeze is placed on a request "directly from the
 * consumer" (15 U.S.C. 1681c-1(i)(2)); submitting freezes or identity-theft blocks for a client was considered and
 * rejected. The only thing the app stores is the client's own tick: "I placed this on <date>" (clients.file_protections,
 * db/migrations/0022_file_protections.sql).
 *
 * ACCURACY RULE (same as agencies.ts). A link or phone number is stored ONLY if it was read on the organisation's own
 * website, or on consumer.ftc.gov / consumerfinance.gov, with the page it was read on and the day it was read. Where
 * nothing was confirmed the field is null and the screen says so. "Free" is shown only where the cited page says it.
 * Enforced by tests/unit/protections.test.ts. Re-read the page before changing an entry and update `readOn`.
 *
 * What was and was not confirmed on 2026-11-19:
 *  - Experian, Equifax, TransUnion: the FTC and CFPB pages below name each bureau's help page as the place to ask for
 *    a freeze or a fraud alert. The bureaus' own freeze pages were not opened, so no bureau phone number is stored.
 *  - ChexSystems: its "Place a Freeze" page was read. No ChexSystems page describing how to add a consumer statement
 *    was found, so that entry has no link.
 *  - Early Warning: its consumer pages describe the file disclosure and disputes. No page about a security freeze was
 *    found, so no freeze is listed for it.
 *  - LexisNexis, Innovis, NCTUE, OptOutPrescreen: the cited pages were read.
 *
 * Federal law behind the entries (cited, not interpreted): free security freezes and fraud alerts at the nationwide
 * bureaus, 15 U.S.C. 1681c-1; opting out of prescreened offers, 15 U.S.C. 1681b(e); a consumer's statement of dispute
 * after a reinvestigation, 15 U.S.C. 1681i(b); file disclosure, 15 U.S.C. 1681g. Freezes at specialty agencies
 * generally rest on state law or the agency's own policy.
 */
import type { Db } from '../db';
import { agencyByKey } from './agencies';

type Lang = 'en' | 'es';
type Text = Record<Lang, string>;

export const PROTECTION_KINDS = ['freeze', 'fraud_alert', 'opt_out', 'consumer_statement', 'file_disclosure'] as const;
export type ProtectionKind = (typeof PROTECTION_KINDS)[number];
export const PROTECTION_KIND_LABEL: Record<ProtectionKind, Text> = {
  freeze: { en: 'Security freeze', es: 'Congelamiento de seguridad' },
  fraud_alert: { en: 'Fraud alert', es: 'Alerta de fraude' },
  opt_out: { en: 'Opt-out', es: 'Exclusión voluntaria' },
  consumer_statement: { en: 'Consumer statement', es: 'Declaración del consumidor' },
  file_disclosure: { en: 'Free file disclosure', es: 'Informe gratuito de su expediente' },
};

/** Where a stored fact was read, and when. */
export interface Sourced { sourceUrl: string; readOn: string }
export interface ProtectionOption {
  /** Stable key, stored in clients.file_protections. Lower-case letters, digits and underscores only. */
  key: string;
  /** A key of AGENCIES (agencies.ts) or of EXTRA_ORGS below. */
  org: string;
  kind: ProtectionKind;
  /** What it does, in one honest sentence. */
  does: Text;
  /** What it does NOT do, in one honest sentence. */
  doesNot: Text;
  /** Who can ask for it, where the organisation's page limits that. */
  who?: Text;
  /** Always the consumer. The agency (the app's customer) never requests these for a client. */
  requestedBy: 'consumer';
  /** The official page where the consumer starts. Null where none was confirmed. */
  link: ({ url: string } & Sourced) | null;
  /** A phone number printed on the cited page, as an alternative to the website. */
  phone: ({ number: string } & Sourced) | null;
  /** Set only where the cited page says there is no charge. */
  free: Sourced | null;
}

const READ = '2026-11-19';
const FTC_FREEZE = 'https://consumer.ftc.gov/articles/credit-freezes-and-fraud-alerts';
const CFPB_FREEZE = 'https://www.consumerfinance.gov/ask-cfpb/what-is-a-credit-freeze-or-security-freeze-on-my-credit-report-en-1341/';
const FTC_PRESCREEN = 'https://consumer.ftc.gov/articles/prescreened-credit-insurance-offers';
const CHEX_FREEZE = 'https://www.chexsystems.com/security-freeze/place-freeze';
const EWS = 'https://www.earlywarning.com/consumer-information';
const LN_FREEZE = 'https://consumer.risk.lexisnexis.com/freeze';
const LN_OPT = 'https://consumer.risk.lexisnexis.com/opt';
const INNOVIS_FREEZE = 'https://www.innovis.com/personal/securityFreeze';
const NCTUE = 'https://nctue.com/consumer/';
const src = (sourceUrl: string): Sourced => ({ sourceUrl, readOn: READ });
const link = (url: string, sourceUrl = url) => ({ url, sourceUrl, readOn: READ });
const phone = (number: string, sourceUrl: string) => ({ number, sourceUrl, readOn: READ });

const FREEZE_NOT: Text = {
  en: 'It does not remove or correct anything on the report, and companies you already have accounts with can generally still see it.',
  es: 'No elimina ni corrige nada del informe, y las empresas con las que ya tiene cuentas generalmente pueden seguir viéndolo.',
};
const ALERT_NOT: Text = {
  en: 'It does not block access to the report and does not remove or correct anything on it.',
  es: 'No bloquea el acceso al informe ni elimina o corrige nada de lo que contiene.',
};
const ALERT_WHO: Text = {
  en: 'For people who are, or suspect they may be, affected by identity theft. An extended alert requires an identity theft report.',
  es: 'Para personas que son, o sospechan que pueden ser, afectadas por el robo de identidad. Una alerta extendida requiere un informe de robo de identidad.',
};

/** The three nationwide bureaus share the same two options; the FTC and CFPB pages give one help page per bureau. */
const BUREAU_PAGE: Record<string, string> = {
  experian: 'https://www.experian.com/help/',
  equifax: 'https://www.equifax.com/personal/credit-report-services/',
  transunion: 'https://www.transunion.com/credit-help',
};
const bureau = (org: string): ProtectionOption[] => [
  {
    key: `${org}_freeze`, org, kind: 'freeze', requestedBy: 'consumer',
    does: {
      en: 'Restricts access to this bureau’s credit report for new credit until you lift it. Each of the three bureaus is asked separately.',
      es: 'Restringe el acceso al informe de crédito de esta agencia para crédito nuevo hasta que usted lo levante. Se pide por separado en cada una de las tres agencias.',
    },
    doesNot: FREEZE_NOT,
    link: link(BUREAU_PAGE[org]!, CFPB_FREEZE), phone: null, free: src(CFPB_FREEZE),
  },
  {
    key: `${org}_fraud_alert`, org, kind: 'fraud_alert', requestedBy: 'consumer',
    does: {
      en: 'Asks businesses to confirm it is really you before opening new credit. An initial alert generally lasts one year; the bureau you ask must tell the other two.',
      es: 'Pide a las empresas confirmar que realmente es usted antes de abrir crédito nuevo. Una alerta inicial generalmente dura un año; la agencia a la que la pide debe avisar a las otras dos.',
    },
    doesNot: ALERT_NOT, who: ALERT_WHO,
    link: link(BUREAU_PAGE[org]!, FTC_FREEZE), phone: null, free: src(FTC_FREEZE),
  },
];

export const PROTECTION_OPTIONS: ProtectionOption[] = [
  ...bureau('experian'), ...bureau('equifax'), ...bureau('transunion'),

  // ---- Innovis
  {
    key: 'innovis_freeze', org: 'innovis', kind: 'freeze', requestedBy: 'consumer',
    does: {
      en: 'Prevents most third parties from getting your Innovis Credit Report in connection with an application for new credit.',
      es: 'Impide que la mayoría de los terceros obtengan su informe de crédito de Innovis en relación con una solicitud de crédito nuevo.',
    },
    doesNot: {
      en: 'It does not remove or correct anything on the report. Companies you already have accounts with, their collection agencies and government agencies can still see it.',
      es: 'No elimina ni corrige nada del informe. Las empresas con las que ya tiene cuentas, sus agencias de cobranza y las agencias del gobierno pueden seguir viéndolo.',
    },
    link: link(INNOVIS_FREEZE), phone: phone('1-866-712-4546', INNOVIS_FREEZE), free: null,
  },

  // ---- ChexSystems
  {
    key: 'chexsystems_freeze', org: 'chexsystems', kind: 'freeze', requestedBy: 'consumer',
    does: {
      en: 'Places a security freeze on your ChexSystems file. ChexSystems sends you a PIN that you need to lift or remove it.',
      es: 'Coloca un congelamiento de seguridad en su expediente de ChexSystems. ChexSystems le envía un PIN que necesita para levantarlo o retirarlo.',
    },
    doesNot: {
      en: 'It does not remove or correct anything ChexSystems reports about you.',
      es: 'No elimina ni corrige nada de lo que ChexSystems reporta sobre usted.',
    },
    link: link(CHEX_FREEZE), phone: phone('800-887-7652', CHEX_FREEZE), free: null,
  },
  {
    key: 'chexsystems_statement', org: 'chexsystems', kind: 'consumer_statement', requestedBy: 'consumer',
    does: {
      en: 'Generally, when a dispute is not resolved by the reinvestigation, you may add a brief statement of your own to the file, in your words.',
      es: 'Generalmente, cuando una disputa no se resuelve con la reinvestigación, usted puede añadir al expediente una declaración breve, con sus propias palabras.',
    },
    doesNot: {
      en: 'It does not change or remove the item it is about. It sits next to it for whoever reads the report.',
      es: 'No cambia ni elimina el dato al que se refiere. Queda junto a él para quien lea el informe.',
    },
    // No ChexSystems page describing how to add a statement was found on 2026-11-19. The screen tells the client to ask ChexSystems.
    link: null, phone: null, free: null,
  },

  // ---- Early Warning. No security freeze is listed: none of its consumer pages read on 2026-11-19 describes one.
  {
    key: 'early_warning_disclosure', org: 'early_warning', kind: 'file_disclosure', requestedBy: 'consumer',
    does: {
      en: 'Shows you what Early Warning has on file about your checking and savings account history.',
      es: 'Le muestra lo que Early Warning tiene registrado sobre su historial de cuentas de cheques y de ahorros.',
    },
    doesNot: {
      en: 'Asking for it does not change the file. It is how you check whether the information is accurate and complete.',
      es: 'Pedirlo no cambia el expediente. Sirve para revisar si la información es exacta y completa.',
    },
    link: link('https://www.earlywarning.com/your-early-warning-file-disclosure', EWS), phone: null, free: src(EWS),
  },

  // ---- LexisNexis Risk Solutions
  {
    key: 'lexisnexis_disclosure', org: 'lexisnexis', kind: 'file_disclosure', requestedBy: 'consumer',
    does: {
      en: 'Shows you the LexisNexis Consumer Disclosure Report: what LexisNexis Risk Solutions holds about you.',
      es: 'Le muestra el informe de LexisNexis (Consumer Disclosure Report): lo que LexisNexis Risk Solutions tiene sobre usted.',
    },
    doesNot: {
      en: 'Asking for it does not change the file. It is how you check whether the information is accurate and complete.',
      es: 'Pedirlo no cambia el expediente. Sirve para revisar si la información es exacta y completa.',
    },
    link: link('https://consumer.risk.lexisnexis.com/consumer', LN_FREEZE), phone: null, free: null,
  },
  {
    key: 'lexisnexis_freeze', org: 'lexisnexis', kind: 'freeze', requestedBy: 'consumer',
    does: {
      en: 'Stops LexisNexis Risk Solutions from releasing your LexisNexis consumer report or credit score without your authorization, for the purposes your state’s law covers.',
      es: 'Impide que LexisNexis Risk Solutions entregue su informe de consumidor o su puntaje sin su autorización, para los fines que cubre la ley de su estado.',
    },
    doesNot: {
      en: 'It applies only at LexisNexis, not at any other agency, and not to companies you already have an account with. It does not remove or correct records.',
      es: 'Se aplica solo en LexisNexis, no en otras agencias, y no a las empresas con las que ya tiene una cuenta. No elimina ni corrige registros.',
    },
    link: link(LN_FREEZE), phone: phone('1-800-456-1244', LN_FREEZE), free: src(LN_FREEZE),
  },
  {
    key: 'lexisnexis_marketing_opt_out', org: 'lexisnexis', kind: 'opt_out', requestedBy: 'consumer',
    does: {
      en: 'Takes your information off the prescreen lists LexisNexis compiles for firm offers of credit or insurance, and out of its direct marketing services.',
      es: 'Retira su información de las listas de preselección que LexisNexis prepara para ofertas firmes de crédito o seguro, y de sus servicios de mercadeo directo.',
    },
    doesNot: {
      en: 'It does not delete any record or change your consumer report, and it does not cover lists from Equifax, Experian, TransUnion or other companies.',
      es: 'No borra ningún registro ni cambia su informe de consumidor, y no cubre las listas de Equifax, Experian, TransUnion ni de otras empresas.',
    },
    link: link(LN_OPT), phone: phone('1-888-497-0011', LN_OPT), free: null,
  },
  {
    key: 'lexisnexis_safety_suppression', org: 'lexisnexis', kind: 'opt_out', requestedBy: 'consumer',
    does: {
      en: 'Asks LexisNexis to suppress certain personal information about you from its restricted public records products.',
      es: 'Pide a LexisNexis suprimir cierta información personal suya de sus productos restringidos de registros públicos.',
    },
    doesNot: {
      en: 'It does not delete public records or stop other companies and public agencies from sharing them, and LexisNexis says it generally does not apply to its Fair Credit Reporting Act products or to law enforcement.',
      es: 'No borra registros públicos ni impide que otras empresas y oficinas públicas los difundan, y LexisNexis indica que generalmente no se aplica a sus productos regidos por la ley FCRA ni a las fuerzas del orden.',
    },
    who: {
      en: 'Per LexisNexis: public and elected officials, judges and law enforcement officers, and private individuals at risk because of a threat to their personal safety or where the law allows. It asks for documentation and decides whether the request qualifies.',
      es: 'Según LexisNexis: funcionarios públicos y electos, jueces y agentes del orden, y personas particulares en riesgo por una amenaza a su seguridad personal o donde la ley lo permita. Pide documentación y decide si la solicitud califica.',
    },
    link: link(LN_OPT), phone: phone('1-888-497-0011', LN_OPT), free: null,
  },

  // ---- NCTUE (telecom and utilities). Everything below is on its one consumer page.
  {
    key: 'nctue_freeze', org: 'nctue', kind: 'freeze', requestedBy: 'consumer',
    does: {
      en: 'Is designed to prevent the information in your NCTUE data file from being reported to others, such as service providers, with some exceptions.',
      es: 'Está pensado para impedir que la información de su expediente de NCTUE se entregue a otros, como proveedores de servicios, con algunas excepciones.',
    },
    doesNot: {
      en: 'It does not remove or correct anything in the NCTUE file, and it applies only at NCTUE.',
      es: 'No elimina ni corrige nada del expediente de NCTUE, y se aplica solo en NCTUE.',
    },
    link: link(NCTUE), phone: phone('1-866-349-5355', NCTUE), free: src(NCTUE),
  },
  {
    key: 'nctue_fraud_alert', org: 'nctue', kind: 'fraud_alert', requestedBy: 'consumer',
    does: {
      en: 'Tells anyone requesting your NCTUE report that you suspect fraud, so a service provider should verify that a request in your name is really yours.',
      es: 'Avisa a quien pida su informe de NCTUE que usted sospecha un fraude, para que el proveedor verifique que una solicitud a su nombre es realmente suya.',
    },
    doesNot: ALERT_NOT,
    who: {
      en: 'For people who suspect they are a victim of fraud. NCTUE requires a police report or FTC identity theft report for an extended alert.',
      es: 'Para personas que sospechan ser víctimas de fraude. NCTUE exige un informe policial o un informe de robo de identidad de la FTC para una alerta extendida.',
    },
    link: link(NCTUE), phone: phone('1-866-349-3233', NCTUE), free: src(NCTUE),
  },
  {
    key: 'nctue_opt_out', org: 'nctue', kind: 'opt_out', requestedBy: 'consumer',
    does: {
      en: 'Keeps NCTUE information about you out of the lists it gives companies that make pre-approved offers of credit.',
      es: 'Mantiene la información de NCTUE sobre usted fuera de las listas que entrega a empresas que hacen ofertas de crédito preaprobadas.',
    },
    doesNot: {
      en: 'It does not delete anything from the NCTUE file and does not cover lists from other companies.',
      es: 'No borra nada del expediente de NCTUE ni cubre las listas de otras empresas.',
    },
    link: link(NCTUE), phone: phone('1-888-327-4376', NCTUE), free: null,
  },
  {
    key: 'nctue_statement', org: 'nctue', kind: 'consumer_statement', requestedBy: 'consumer',
    does: {
      en: 'If the service provider verifies disputed information as accurate, it stays on the report and you may add a statement of explanation to it.',
      es: 'Si el proveedor verifica como exacta la información disputada, esta permanece en el informe y usted puede añadirle una declaración explicativa.',
    },
    doesNot: {
      en: 'It does not change or remove the item it is about.',
      es: 'No cambia ni elimina el dato al que se refiere.',
    },
    link: link(NCTUE), phone: null, free: null,
  },

  // ---- Prescreened offers (15 U.S.C. 1681b(e)). The website is run by Equifax, Experian, Innovis and TransUnion.
  {
    key: 'optoutprescreen', org: 'optoutprescreen', kind: 'opt_out', requestedBy: 'consumer',
    does: {
      en: 'Takes you off the lists Equifax, Experian, Innovis and TransUnion give lenders and insurers for prescreened offers: for five years online or by phone, or permanently with a signed form.',
      es: 'Lo retira de las listas que Equifax, Experian, Innovis y TransUnion entregan a prestamistas y aseguradoras para ofertas preseleccionadas: por cinco años en línea o por teléfono, o de forma permanente con un formulario firmado.',
    },
    doesNot: {
      en: 'It does not change what is on your credit reports and does not stop offers based on lists from other sources. You can opt back in.',
      es: 'No cambia lo que aparece en sus informes de crédito ni detiene las ofertas basadas en listas de otras fuentes. Puede volver a incluirse.',
    },
    link: link('https://www.optoutprescreen.com/'), phone: phone('1-888-567-8688', FTC_PRESCREEN), free: null,
  },
];

/** Organisations that are not consumer reporting agencies in the registry. */
const EXTRA_ORGS: Record<string, { name: string; note: Text }> = {
  optoutprescreen: {
    name: 'OptOutPrescreen.com',
    note: {
      en: 'The credit reporting industry’s website for opting in or out of prescreened offers of credit or insurance.',
      es: 'El sitio de la industria de informes de crédito para aceptar o rechazar ofertas preseleccionadas de crédito o seguro.',
    },
  },
};

export interface ProtectionGroup { org: string; name: string; note: Text; options: ProtectionOption[] }
/** The options grouped by organisation, in the order of the list above. */
export const PROTECTION_GROUPS: ProtectionGroup[] = [...new Set(PROTECTION_OPTIONS.map((o) => o.org))].map((org) => {
  const a = agencyByKey(org);
  const x = EXTRA_ORGS[org];
  return { org, name: a?.shortName ?? x!.name, note: a?.reports ?? x!.note, options: PROTECTION_OPTIONS.filter((o) => o.org === org) };
});

export const protectionByKey = (key: string | null | undefined): ProtectionOption | undefined => PROTECTION_OPTIONS.find((o) => o.key === key);

/** Hosts a stored link or source may point to: each organisation's own site, the FTC and the CFPB. Nothing else. */
export const OFFICIAL_HOSTS = [
  'www.experian.com', 'www.equifax.com', 'www.transunion.com', 'www.innovis.com', 'www.chexsystems.com', 'www.earlywarning.com',
  'consumer.risk.lexisnexis.com', 'nctue.com', 'www.optoutprescreen.com', 'consumer.ftc.gov', 'www.consumerfinance.gov',
] as const;

// ---------------------------------------------------------------- the client's own ticks
/** Reads clients.file_protections: option key -> the day the client says they placed it. Unknown keys and bad dates are ignored. */
export function protectionTicks(raw: unknown): Record<string, string> {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const p of PROTECTION_OPTIONS) {
    const v = o[p.key];
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) out[p.key] = v;
  }
  return out;
}

export class ProtectionError extends Error {}
type Runner = Pick<Db, 'run'>;
/**
 * Records or clears the client's own tick. Call it inside the client's own tenant transaction: row-level security limits
 * the update to their own clients row, and the database trigger (0022) refuses the change from anyone else.
 * `on` null clears the tick. Nothing is sent anywhere.
 */
export async function setProtectionTick(db: Runner, clientId: string, key: string, on: string | null, today: string): Promise<void> {
  const p = protectionByKey(key);
  if (!p) throw new ProtectionError('unknown option');
  if (on === null) {
    await db.run('update public.clients set file_protections = file_protections - $2::text where id = $1', [clientId, p.key]);
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || Number.isNaN(new Date(`${on}T00:00:00Z`).getTime()) || on > today) throw new ProtectionError('invalid date');
  await db.run('update public.clients set file_protections = file_protections || jsonb_build_object($2::text, $3::text) where id = $1', [clientId, p.key, on]);
}
