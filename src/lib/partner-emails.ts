/**
 * Email to referral partners: businesses that can refer clients to an agency (real estate agents, loan officers,
 * mortgage brokers, car dealerships, tax preparers, property managers). Pure: no database, no network.
 *
 * The rules this file holds every message to (the unit tests check each one):
 *  - It says what the agency does (helps consumers review their credit reports and dispute inaccurate information) and
 *    never promises a result, a score, an approval or a time frame. Subject and body pass the marketing claims guard.
 *  - It greets the contact by first name and states only what is on the partner record (the category and city the
 *    agency entered) and what the agency said about itself. Nothing is claimed about the partner, their work or any
 *    earlier contact.
 *  - The subject says what the email is. No "Re:", no pretend reply, no urgency.
 *  - The footer identifies the message as a business solicitation, names the agency with its postal address and
 *    carries the opt-out link (CAN-SPAM, 15 U.S.C. § 7704).
 *  - The wording is fixed. Nothing a model writes is emailed to a partner: these emails go out with nobody reading each
 *    one, and no check on free text is good enough for that.
 * Partners are emailed only. Nothing in this product texts or calls a partner.
 */
import { addBusinessDays, isBusinessDay, type Day } from './business-days';
import { findBlockedClaims, findMarketingClaims, type ClaimIssue } from './compliance/claims';
import { greetingName } from './lead-emails';
import { linkInName } from './lead-texts';

// ---------------------------------------------------------------- who a partner is
export const PARTNER_CATEGORIES = ['real_estate_agent', 'loan_officer', 'mortgage_broker', 'car_dealership', 'tax_preparer', 'property_manager', 'other'] as const;
export type PartnerCategory = (typeof PARTNER_CATEGORIES)[number];
export const PARTNER_CATEGORY_LABEL: Record<PartnerCategory, string> = {
  real_estate_agent: 'Real estate agent', loan_officer: 'Loan officer', mortgage_broker: 'Mortgage broker', car_dealership: 'Car dealership',
  tax_preparer: 'Tax preparer', property_manager: 'Property manager', other: 'Other business',
};
export const isPartnerCategory = (v: unknown): v is PartnerCategory => typeof v === 'string' && (PARTNER_CATEGORIES as readonly string[]).includes(v);

export const PARTNER_STATUSES = ['new', 'in_sequence', 'finished', 'replied', 'interested', 'not_interested', 'bounced', 'opted_out'] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];
export const PARTNER_STATUS_LABEL: Record<PartnerStatus, string> = {
  new: 'New', in_sequence: 'In sequence', finished: 'Sequence finished', replied: 'Replied', interested: 'Interested',
  not_interested: 'Not interested', bounced: 'Bounced', opted_out: 'Opted out',
};

// ---------------------------------------------------------------- the sequence and its limits
/** Three emails. The follow-up and the last note are counted in business days from the day the introduction went out. */
export const PARTNER_STEPS = [
  { key: 'intro', afterBusinessDays: 0, label: 'Introduction' },
  { key: 'followup', afterBusinessDays: 4, label: 'Follow-up' },
  { key: 'final', afterBusinessDays: 9, label: 'Last note' },
] as const;
export type PartnerStep = (typeof PARTNER_STEPS)[number]['key'];
export const partnerStepLabel = (step: string) => PARTNER_STEPS.find((s) => s.key === step)?.label ?? step;
/** Never two emails to one partner closer together than this, even when the schedule ran late or was paused. */
export const PARTNER_MIN_GAP_BUSINESS_DAYS = 3;
/** A step that failed is tried again only when a staff member asks, and never more than this many times in all. */
export const PARTNER_MAX_ATTEMPTS = 3;
/** Most partner emails one agency sends in any 24 hours. */
export const PARTNER_DAILY_CAP = 40;
/** Most partner emails one scheduled run sends for one agency, so a list goes out spread over runs, not at once. */
export const PARTNER_PER_RUN_CAP = 10;
/**
 * After this many sends in a row that the email service refused, the sequence holds for the whole agency: the service
 * is probably refusing everything (a sending domain that is not verified, a revoked key), and trying partner after
 * partner would only stop each of them. It holds for PARTNER_FAILURE_HOLD_HOURS, or until a person asks for another
 * try. An email this app's own guard refused, or one the service gave no answer for, is not counted.
 */
export const PARTNER_RUN_FAILURE_LIMIT = 2;
export const PARTNER_FAILURE_HOLD_HOURS = 24;
/**
 * How long one run may keep sending for one agency. The scheduled job handles every agency in one request with a time
 * limit of its own, so a slow email service must not use it all up: what is left goes out with the next run.
 */
export const PARTNER_RUN_BUDGET_MS = 20_000;

export interface PartnerSendRow { step: string; status: string; attempts?: number; /** The day it was sent, in the agency's time zone. */ sentOn: Day | null }
export interface PartnerState { status: string; paused: boolean; outreach: PartnerSendRow[] }
export type PartnerStopReason = 'opted_out' | 'bounced' | 'replied' | 'interested' | 'not_interested' | 'finished' | 'paused' | 'failed' | 'unconfirmed';
export type PartnerDecision = { kind: 'send'; step: PartnerStep } | { kind: 'wait'; step: PartnerStep; dueOn: Day } | { kind: 'stop'; reason: PartnerStopReason };

const stop = (reason: PartnerStopReason): PartnerDecision => ({ kind: 'stop', reason });

/**
 * Which email, if any, a partner should get today. The single rule used by the scheduled job and by the Partners page.
 * It stops for good on an opt-out, a recorded reply, "interested", "not interested" or a bounce; it waits while paused;
 * and it stops after a failed send or one whose outcome was never confirmed, so nothing is ever sent on top of either.
 * Emails go out on business days only.
 */
export function decidePartnerStep(s: PartnerState, today: Day): PartnerDecision {
  if (s.status !== 'new' && s.status !== 'in_sequence') {
    return stop((['opted_out', 'bounced', 'replied', 'interested', 'not_interested'] as const).find((r) => r === s.status) ?? 'finished');
  }
  if (s.paused) return stop('paused');
  // Handed to the email service but never confirmed (a crash, a lost connection): it may have arrived, so it is not sent again.
  if (s.outreach.some((o) => o.status === 'sending')) return stop('unconfirmed');
  if (s.outreach.some((o) => o.status === 'failed')) return stop('failed');
  const sent = s.outreach.filter((o) => o.status === 'sent');
  const next = PARTNER_STEPS.find((st) => !sent.some((o) => o.step === st.key));
  if (!next) return stop('finished');
  const prior = s.outreach.find((o) => o.step === next.key); // only a step a staff member asked to try again can be here
  if (prior && (prior.attempts ?? 1) >= PARTNER_MAX_ATTEMPTS) return stop('failed');
  let due = today;
  const introOn = sent.find((o) => o.step === 'intro')?.sentOn;
  const lastOn = sent.map((o) => o.sentOn).filter((d): d is Day => !!d).sort().at(-1);
  if (next.key !== 'intro' && introOn) due = addBusinessDays(introOn, next.afterBusinessDays);
  if (lastOn) { const gap = addBusinessDays(lastOn, PARTNER_MIN_GAP_BUSINESS_DAYS); if (gap > due) due = gap; }
  if (due < today) due = today;
  if (!isBusinessDay(due)) due = addBusinessDays(due, 1);
  return due <= today ? { kind: 'send', step: next.key } : { kind: 'wait', step: next.key, dueOn: due };
}

// ---------------------------------------------------------------- wording
export type PartnerLang = 'en' | 'es';
interface CategoryCopy { /** Completes "I am contacting you because …"; `place` is "" or " in City, ST". */ reason: (place: string) => string; people: string; situation: string }

const EN_CATEGORY: Record<PartnerCategory, CategoryCopy> = {
  real_estate_agent: { reason: (p) => `you work as a real estate agent${p}`, people: 'buyers', situation: 'Some of the buyers you work with may be told by a lender that their credit reports need attention before a loan can move ahead.' },
  loan_officer: { reason: (p) => `you work as a loan officer${p}`, people: 'applicants', situation: 'Some of the applicants you see may have entries on their credit reports that they believe are wrong.' },
  mortgage_broker: { reason: (p) => `you work as a mortgage broker${p}`, people: 'applicants', situation: 'Some of the applicants you work with may have entries on their credit reports that they believe are wrong.' },
  car_dealership: { reason: (p) => `you work at a car dealership${p}`, people: 'customers', situation: 'Some of the customers who ask you about financing may have entries on their credit reports that they believe are wrong.' },
  tax_preparer: { reason: (p) => `you work as a tax preparer${p}`, people: 'clients', situation: 'Some of your clients may mention entries on their credit reports that they believe are wrong.' },
  property_manager: { reason: (p) => `you work in property management${p}`, people: 'applicants', situation: 'Some rental applicants may have entries on their credit reports that they believe are wrong.' },
  other: { reason: (p) => `the people your business serves${p} may sometimes have questions about their credit reports`, people: 'customers', situation: 'Some of the people you serve may have entries on their credit reports that they believe are wrong.' },
};
const ES_CATEGORY: Record<PartnerCategory, CategoryCopy> = {
  real_estate_agent: { reason: (p) => `trabaja como agente de bienes raíces${p}`, people: 'compradores', situation: 'Es posible que a algunos de los compradores con los que usted trabaja un prestamista les diga que sus informes de crédito necesitan atención antes de que un préstamo pueda avanzar.' },
  loan_officer: { reason: (p) => `trabaja como oficial de préstamos${p}`, people: 'solicitantes', situation: 'Es posible que algunos de los solicitantes que usted atiende tengan en sus informes de crédito datos que consideran incorrectos.' },
  mortgage_broker: { reason: (p) => `trabaja como corredor hipotecario${p}`, people: 'solicitantes', situation: 'Es posible que algunos de los solicitantes con los que usted trabaja tengan en sus informes de crédito datos que consideran incorrectos.' },
  car_dealership: { reason: (p) => `trabaja en un concesionario de autos${p}`, people: 'clientes', situation: 'Es posible que algunos de los clientes que le preguntan por financiamiento tengan en sus informes de crédito datos que consideran incorrectos.' },
  tax_preparer: { reason: (p) => `trabaja como preparador de impuestos${p}`, people: 'clientes', situation: 'Es posible que algunos de sus clientes le mencionen datos de sus informes de crédito que consideran incorrectos.' },
  property_manager: { reason: (p) => `trabaja en administración de propiedades${p}`, people: 'solicitantes', situation: 'Es posible que algunos solicitantes de alquiler tengan en sus informes de crédito datos que consideran incorrectos.' },
  other: { reason: (p) => `las personas a las que atiende su negocio${p} a veces pueden tener preguntas sobre sus informes de crédito`, people: 'clientes', situation: 'Es posible que algunas de las personas a las que usted atiende tengan en sus informes de crédito datos que consideran incorrectos.' },
};

type StepCopy = { subject: string; body: string[] };
/** {name} greeting name · {org} agency · {reason} {situation} {people} from the category · {site} "" or a sentence with the agency's website. */
const EN: Record<PartnerStep, StepCopy> = {
  intro: {
    subject: 'Introducing {org}: credit report help for your {people}',
    body: [
      '{hello}',
      'I am writing from {org}, a credit repair company. I am contacting you because {reason}.',
      '{situation} When that happens, we can help them read their credit reports and dispute, in writing, information they believe is inaccurate, incomplete or cannot be verified.',
      'To be plain about what we cannot do: we cannot promise a result, a particular credit score or a loan approval for anyone. The credit bureaus, the companies that report to them and lenders make their own decisions, and accurate information stays on a credit report. Consumers also have the right to dispute inaccurate information with the credit bureaus on their own.',
      'If it would help to have someone you can point those {people} to, reply to this email and I will tell you how we work.{site}',
      'Thank you for your time.',
    ],
  },
  followup: {
    subject: 'Following up: {org} and your {people}',
    body: [
      '{hello}',
      'This is a short follow-up to the note I sent you about {org}.',
      'If any of the {people} you work with ask where to turn about entries on their credit reports that they believe are wrong, we would be glad to be one of the options you mention. We go through their reports with them and help them dispute inaccurate information in writing. We do not promise results, and we tell them so.',
      'To talk it over, reply to this email with a good time to reach you.{site}',
    ],
  },
  final: {
    subject: 'Last note from {org}',
    body: [
      '{hello}',
      'This is the last note I will send you about {org}. If now is not the right time, you do not need to do anything, and we will not keep writing.',
      'If you would like to hear how we work with {people} who have questions about their credit reports, reply to this email whenever it suits you.',
      'Thank you for your time.',
    ],
  },
};
const ES: Record<PartnerStep, StepCopy> = {
  intro: {
    subject: 'Le presentamos a {org}: ayuda con informes de crédito para sus {people}',
    body: [
      '{hello}',
      'Le escribo de parte de {org}, una empresa de reparación de crédito. Me comunico con usted porque {reason}.',
      '{situation} Cuando eso ocurre, podemos ayudarles a leer sus informes de crédito y a disputar por escrito la información que consideran inexacta, incompleta o que no puede verificarse.',
      'Para ser claros sobre lo que no podemos hacer: no podemos prometer un resultado, un puntaje de crédito en particular ni la aprobación de un préstamo para nadie. Las agencias de crédito, las empresas que les reportan y los prestamistas toman sus propias decisiones, y la información exacta permanece en el informe de crédito. Los consumidores también tienen derecho a disputar por su cuenta la información inexacta ante las agencias de crédito.',
      'Si le sería útil tener a quién referir a los {people} que estén en esa situación, responda a este correo y le explicaré cómo trabajamos.{site}',
      'Gracias por su tiempo.',
    ],
  },
  followup: {
    subject: 'Seguimiento: {org} y sus {people}',
    body: [
      '{hello}',
      'Este es un breve seguimiento de la nota que le envié sobre {org}.',
      'Si alguno de los {people} con los que usted trabaja le pregunta a dónde acudir por datos de sus informes de crédito que considera incorrectos, con gusto seríamos una de las opciones que usted mencione. Revisamos sus informes con ellos y les ayudamos a disputar por escrito la información inexacta. No podemos prometer resultados, y así se lo decimos.',
      'Para conversarlo, responda a este correo con un buen momento para comunicarnos.{site}',
    ],
  },
  final: {
    subject: 'Última nota de {org}',
    body: [
      '{hello}',
      'Esta es la última nota que le enviaré sobre {org}. Si ahora no es el momento adecuado, no necesita hacer nada, y no le seguiremos escribiendo.',
      'Si desea saber cómo trabajamos con {people} que tienen preguntas sobre sus informes de crédito, responda a este correo cuando le convenga.',
      'Gracias por su tiempo.',
    ],
  },
};

/** Fixed footer: what the message is, who sent it and from where, and how to stop it. */
const FOOTER: Record<PartnerLang, [string, string, string]> = {
  en: [
    'This is a business solicitation from {org}. You are receiving it because {org} added this address to its list of business contacts.',
    'Stop these emails: {optOut}',
    'A reply reaches our team, but it does not stop these emails by itself. The link above does: it opens a page with one button, and pressing it stops them for good.',
  ],
  es: [
    'Este mensaje es una oferta comercial de {org}. Usted lo recibe porque {org} agregó esta dirección a su lista de contactos de negocios.',
    'Dejar de recibir estos correos: {optOut}',
    'Una respuesta llega a nuestro equipo, pero por sí sola no detiene estos correos. El enlace anterior sí: abre una página con un solo botón, y al pulsarlo se detienen de forma permanente.',
  ],
};

const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
/**
 * A city as it may be printed in an email: one to four words of letters, 40 characters at most ("Austin", "St. Louis",
 * "Winston-Salem", "Coeur d'Alene", "Truth or Consequences"). A full stop is allowed only to end St, Ft or Mt. So a
 * sentence ("Austin. We met at the expo"), a web address or a note typed into the wrong column is not a city: it is
 * refused when the partner is added (partnerSchema), not dropped quietly when the email is built.
 */
export function isPlainCity(raw: string): boolean {
  const c = oneLine(raw);
  if (!c || c.length > 40) return false;
  const words = c.split(' ');
  return words.length <= 4 && words.every((w) => /^(?:St|Ft|Mt)\.$/i.test(w) || /^\p{L}[\p{L}'’-]*$/u.test(w));
}
/**
 * "City, ST" as it may appear in an email, or '' when the record has nothing usable. The agency typed it, so only a
 * plain place name is used (isPlainCity): a link or a sentence never reaches an email.
 */
export function partnerPlace(city: string | null | undefined, state: string | null | undefined): string {
  const c = oneLine(city ?? '');
  const okCity = isPlainCity(c) ? c : '';
  const st = /^[A-Z]{2}$/.test((state ?? '').trim()) ? (state ?? '').trim() : '';
  return okCity ? (st ? `${okCity}, ${st}` : okCity) : '';
}

export interface PartnerEmailVars {
  contactName: string | null; category: PartnerCategory; city: string | null; state: string | null;
  orgName: string; address: string; optOutUrl: string;
  /** The agency's public website, when it is published. */
  siteUrl?: string | null;
}
export interface PartnerEmail {
  subject: string;
  /** Greeting, paragraphs and signature. */
  body: string;
  /** The fixed lines under the body. */
  footer: string;
  /** body + footer: what is sent. */
  text: string;
}

export const partnerEmailText = (body: string, footer: string) => `${body.trim()}\n\n${footer}`;

/** The full plain-text email for one step, in the partner's language, from the fields on the record and nothing else. */
export function partnerEmail(step: PartnerStep, lang: PartnerLang, v: PartnerEmailVars): PartnerEmail {
  const es = lang === 'es';
  const copy = (es ? ES : EN)[step];
  const cat = (es ? ES_CATEGORY : EN_CATEGORY)[v.category];
  const org = oneLine(v.orgName);
  const name = greetingName(v.contactName ?? '');
  const place = partnerPlace(v.city, v.state);
  const site = v.siteUrl ? (es ? ` Puede leer sobre nosotros aquí: ${v.siteUrl}` : ` You can read about us here: ${v.siteUrl}`) : '';
  const hello = es ? (name ? `Hola ${name}:` : 'Hola:') : (name ? `Hello ${name},` : 'Hello,');
  const vars: Record<string, string> = {
    hello, org, people: cat.people, situation: cat.situation, site,
    reason: cat.reason(place ? (es ? ` en ${place}` : ` in ${place}`) : ''),
    optOut: v.optOutUrl,
  };
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
  const body = [...copy.body, `— ${org}`].map(fill).join('\n\n');
  const foot = FOOTER[es ? 'es' : 'en'];
  const footer = ['--', fill(foot[0]), `${org} · ${oneLine(v.address)}`, fill(foot[1]), foot[2]].join('\n\n');
  return { subject: fill(copy.subject).slice(0, 200), body, footer, text: partnerEmailText(body, footer) };
}

/**
 * The claims guard every partner email is held to, exactly as the sender applies it before an email leaves: the
 * marketing rules on the subject and body, and the base rules on the whole text (the footer carries the agency's name
 * and mailing address). Returns the first issue, or undefined when the email may go.
 */
export const partnerEmailIssue = (m: Pick<PartnerEmail, 'subject' | 'body' | 'text'>): ClaimIssue | undefined =>
  findMarketingClaims(`${m.subject}\n${m.body}`)[0] ?? findBlockedClaims(m.text)[0];

/**
 * Why a city cannot be printed in the introduction ("because you work as a real estate agent in Free Soil, MI"), or
 * null. A real place name can read as a claim to the guard above ("Free Soil"), and the email would then be refused
 * when it is sent. So the partner is refused when it is added (partnerSchema) and the person is told to leave the city
 * out. The city is checked in the sentence it would be printed in, for every category and both languages.
 */
export function partnerCityIssue(city: string): ClaimIssue | null {
  for (const lang of ['en', 'es'] as const) {
    for (const category of PARTNER_CATEGORIES) {
      const issue = partnerEmailIssue(partnerEmail('intro', lang, { contactName: null, category, city, state: null, orgName: 'A', address: '', optOutUrl: '' }));
      if (issue) return issue;
    }
  }
  return null;
}

/** Longest business name the sequence will put in a subject and a From line. Real business names are far shorter. */
export const PARTNER_NAME_MAX = 80;

export interface PartnerWordingIssue {
  /** Which of the agency's own details has to change. */
  part: 'name' | 'website' | 'address';
  why: string;
  excerpt: string;
}

/**
 * Why an agency cannot run the sequence as its own details stand, or null. The business name is part of every subject,
 * From line, body and signature, so it is refused when it carries a web address (every email would then lead with a
 * link) or is long enough to be a message of its own. Then the emails are built as they would leave, for every
 * category, step and language, with what is the same for every partner: the name, the address of the agency's website
 * (linked from the introduction and the follow-up) and its mailing address (printed under every email). They are held
 * to the guard the sender applies (partnerEmailIssue), so what would be refused in every email is refused here, before
 * anything is sent and with the reason shown on the Partners page, and not partner by partner at send time.
 */
export function partnerWordingIssue(orgName: string, own: { siteUrl?: string | null; address?: string } = {}): PartnerWordingIssue | null {
  const name = oneLine(orgName);
  const link = linkInName(name);
  if (link) return { part: 'name', why: 'A business name with a web address in it cannot be used in the subject and From line of these emails.', excerpt: link.slice(0, 80) };
  if (name.length > PARTNER_NAME_MAX) return { part: 'name', why: `A business name longer than ${PARTNER_NAME_MAX} characters cannot be used in a subject line.`, excerpt: `${name.slice(0, 40)}…` };
  const firstIssue = (v: { siteUrl: string | null; address: string }): ClaimIssue | null => {
    for (const lang of ['en', 'es'] as const) {
      for (const category of PARTNER_CATEGORIES) {
        for (const { key } of PARTNER_STEPS) {
          const issue = partnerEmailIssue(partnerEmail(key, lang, { contactName: null, category, city: null, state: null, orgName, optOutUrl: '', ...v }));
          if (issue) return issue;
        }
      }
    }
    return null;
  };
  const siteUrl = own.siteUrl || null;
  const address = own.address ?? '';
  const issue = firstIssue({ siteUrl, address });
  if (!issue) return null;
  // Which of the three has to change: the name by itself, then the name with the website address, else the mailing address.
  const fromName = firstIssue({ siteUrl: null, address: '' });
  if (fromName) return { part: 'name', why: fromName.why, excerpt: fromName.excerpt };
  const fromSite = siteUrl ? firstIssue({ siteUrl, address: '' }) : null;
  if (fromSite) return { part: 'website', why: fromSite.why, excerpt: fromSite.excerpt };
  return { part: 'address', why: issue.why, excerpt: issue.excerpt };
}
