/**
 * Email to referral partners: businesses that can refer clients to an agency (real estate agents, loan officers,
 * mortgage brokers, car dealerships, tax preparers, property managers). Pure: no database, no network.
 *
 * The rules this file holds every message to (the unit tests check each one):
 *  - It says what the agency does (helps consumers review their credit reports and dispute inaccurate information) and
 *    never promises a result, a score, an approval or a time frame. Subject and body pass the marketing claims guard.
 *  - It states only what is on the partner record (the category and city the agency entered) and what the agency
 *    said about itself. Nothing is claimed about the partner, their work or any earlier contact.
 *  - The subject says what the email is. No "Re:", no pretend reply, no urgency.
 *  - The footer identifies the message as a business solicitation, names the agency with its postal address and
 *    carries the opt-out link (CAN-SPAM, 15 U.S.C. § 7704).
 *  - The wording is fixed. Nothing a model writes is emailed to a partner: these emails go out with nobody reading each
 *    one, and no check on free text is good enough for that. (The checks at the foot of this file are what a rewording
 *    would have to pass before a PERSON approved it; the sender does not use them.)
 * Partners are emailed only. Nothing in this product texts or calls a partner.
 */
import { addBusinessDays, isBusinessDay, type Day } from './business-days';
import { findMarketingClaims } from './compliance/claims';
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
 * After this many failed sends in a row the sequence holds for the whole agency: the email service is probably
 * refusing everything (a sending domain that is not verified, a revoked key), and trying partner after partner would
 * only stop each of them. It holds for PARTNER_FAILURE_HOLD_HOURS, or until a person asks for another try.
 */
export const PARTNER_RUN_FAILURE_LIMIT = 2;
export const PARTNER_FAILURE_HOLD_HOURS = 24;
/**
 * How long one run may keep sending for one agency. The scheduled job handles every agency in one request with a time
 * limit of its own, so a slow email or AI service must not use it all up: what is left goes out with the next run.
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

/**
 * Words that would lock a sentence for a rewording (src/lib/ai/protected.ts locks any sentence that contains a
 * protected term, and rejects a rewrite that adds one). They cover what the agency does, what it cannot promise, who decides,
 * and the reader's own work, so the AI can only touch the connecting sentences between them.
 */
const EN_LOCKED_WORDS = ['credit', 'promise', 'score', 'approval', 'lender', 'loan', 'bureau', 'consumer', 'result', 'work as', 'work at', 'work in', 'your business'];
const ES_LOCKED_WORDS = ['crédito', 'prometer', 'puntaje', 'aprobación', 'prestamista', 'préstamo', 'agencia', 'consumidor', 'resultado', 'trabaja como', 'trabaja en', 'su negocio'];

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
  /** Greeting, paragraphs and signature: the only part the optional AI step may reword. */
  body: string;
  /** The fixed lines under the body. */
  footer: string;
  /** body + footer: what is sent. */
  text: string;
  /** Names and places that must never be reworded or added by the AI step. */
  protectedTerms: string[];
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
  // Anything that names the sender, the reader or a place, plus the words every statement about the service and its
  // limits uses: a sentence that contains one is locked, and the AI step cannot write a new sentence that does.
  // (The two-letter state is left out: as a protected term "IN" or "OR" would match inside ordinary words.)
  const protectedTerms = [org, name, place.split(', ')[0] ?? '', v.siteUrl ?? '', ...(es ? ES_LOCKED_WORDS : EN_LOCKED_WORDS)].filter((t) => t.length >= 2);
  return { subject: fill(copy.subject).slice(0, 200), body, footer, text: partnerEmailText(body, footer), protectedTerms };
}

/** Longest business name the sequence will put in a subject and a From line. Real business names are far shorter. */
export const PARTNER_NAME_MAX = 80;

/**
 * Why an agency with this name cannot run the sequence, or null. The name is part of every subject, From line, body
 * and signature, so it is refused when it carries a web address (every email would then lead with a link), when it is
 * long enough to be a message of its own, or when it makes a promise (or reads as one next to the standard words):
 * the sequence does not run until the name is changed. Every category, step and language is checked for claims.
 */
export function partnerWordingIssue(orgName: string): { why: string; excerpt: string } | null {
  const name = oneLine(orgName);
  const link = linkInName(name);
  if (link) return { why: 'A business name with a web address in it cannot be used in the subject and From line of these emails.', excerpt: link.slice(0, 80) };
  if (name.length > PARTNER_NAME_MAX) return { why: `A business name longer than ${PARTNER_NAME_MAX} characters cannot be used in a subject line.`, excerpt: `${name.slice(0, 40)}…` };
  for (const lang of ['en', 'es'] as const) {
    for (const category of PARTNER_CATEGORIES) {
      for (const { key } of PARTNER_STEPS) {
        const m = partnerEmail(key, lang, { contactName: null, category, city: null, state: null, orgName, address: '', optOutUrl: '' });
        const issue = findMarketingClaims(`${m.subject}\n${m.body}`)[0];
        if (issue) return { why: issue.why, excerpt: issue.excerpt };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- nothing invented about the reader
interface FamiliarityRule { id: string; why: string; pattern: RegExp }
/**
 * A pattern that only matches whole words, in English and Spanish alike. JavaScript's `\b` treats an accented letter
 * as a word break ("leí" would never match `\bleí\b`), so the edges are checked against every Unicode letter and digit.
 */
const phrase = (...alternatives: string[]) => new RegExp(String.raw`(?<![\p{L}\p{N}_])(?:${alternatives.join('|')})(?![\p{L}\p{N}_])`, 'iu');
/**
 * Phrases that claim something the sender does not know: that they saw, read or heard something about the partner,
 * that the two have met or spoken, that someone recommended the partner, praise for the partner's reputation, or a
 * track record nobody entered. English and Spanish. Deliberately broad: a false alarm only means the standard wording
 * is used instead of the AI's.
 */
const FAMILIARITY_RULES: FamiliarityRule[] = [
  {
    id: 'saw', why: 'It claims to have seen, read or heard something about the partner.',
    pattern: phrase(
      String.raw`(?:i|we)(?:['’]ve|\s+have|\s+had)?\s+(?:(?:just|recently|also|really)\s+)?(?:saw|seen|noticed|came\s+across|come\s+across|found|read|watched|heard|spotted|stumbled|visited|looked\s+(?:at|up|through)|checked\s+out|been\s+(?:following|watching|reading|admiring|looking))`,
      String.raw`(?:i|we)\s+(?:was|were|am|are)\s+(?:looking|browsing|reading|scrolling|researching)`,
      String.raw`vi|vimos|noté|notamos|encontré|encontramos|leí|leímos|escuché|escuchamos|visité|visitamos|me\s+enteré|nos\s+enteramos`,
      String.raw`(?:he|hemos)\s+(?:visto|notado|leído|seguido|escuchado|encontrado|visitado)`,
    ),
  },
  {
    id: 'recent', why: 'It refers to something recent about the partner that is not on file.',
    pattern: phrase(
      String.raw`your\s+(?:recent|latest|newest|last|new|upcoming)`, 'recently', String.raw`(?:last|this)\s+(?:week|month|year|weekend|quarter)`, 'yesterday', String.raw`the\s+other\s+day`,
      String.raw`sus?\s+(?:recientes?|últim[oa]s?|nuev[oa]s?|próxim[oa]s?)`, 'recientemente', String.raw`hace\s+poco`,
      String.raw`(?:la\s+semana|el\s+mes|el\s+año|el\s+fin\s+de\s+semana)\s+pasad[oa]`, 'ayer', String.raw`el\s+otro\s+día`,
    ),
  },
  {
    id: 'congratulations', why: 'It congratulates the partner on something that is not on file.',
    pattern: phrase('congrats', 'congratulations', 'congratulate', 'felicidades', 'felicitaciones', 'felicito', 'felicitamos', 'enhorabuena'),
  },
  {
    id: 'met', why: 'It claims an earlier meeting or conversation.',
    pattern: phrase(
      String.raw`(?:we|i)\s+(?:met|spoke|talked|chatted|connected|worked\s+together)`,
      String.raw`(?:as|like)\s+(?:we|i)\s+(?:discussed|mentioned|talked|agreed|said)`,
      String.raw`(?:our|my)\s+(?:last|recent|previous|earlier)\s+(?:call|conversation|meeting|chat|discussion|visit)`,
      String.raw`(?:great|nice|good|lovely|a\s+pleasure)\s+(?:to\s+)?(?:meet|meeting|talk|talking|speak|speaking|chat|chatting|see|seeing)`,
      String.raw`per\s+(?:our|my)\s+(?:call|conversation|discussion)`, String.raw`following\s+up\s+on\s+our`,
      String.raw`thanks?(?:\s+you)?\s+for\s+(?:taking\s+(?:my|our|the)\s+call|your\s+(?:reply|response|interest|call|message)|speaking|meeting|chatting)`,
      String.raw`nos\s+(?:conocimos|vimos|reunimos)`, String.raw`(?:como|según)\s+(?:conversamos|hablamos|acordamos|comentamos|platicamos|quedamos)`,
      String.raw`(?:nuestra|mi)\s+(?:última|reciente|anterior)\s+(?:llamada|conversación|reunión|plática|visita)`,
      String.raw`(?:un\s+gusto|un\s+placer|encantad[oa])\s+(?:de\s+)?(?:conocer|hablar|conversar|saludar)\p{L}*`,
      String.raw`gracias\s+por\s+(?:su\s+(?:llamada|respuesta|interés|mensaje)|atender\p{L}*|recibir\p{L}*)`,
    ),
  },
  {
    id: 'referred', why: 'It claims that someone recommended or mentioned the partner.',
    pattern: phrase(
      String.raw`(?:mutual|common|shared)\s+(?:friend|contact|connection|client|acquaintance)s?`, String.raw`(?:referred|recommended|introduced|pointed)\s+(?:me|us)`,
      String.raw`(?:gave|passed)\s+(?:me|us)\s+your`, String.raw`told\s+(?:me|us)`, String.raw`speaks?\s+(?:so\s+)?highly`, String.raw`highly\s+recommended`, String.raw`came\s+recommended`,
      String.raw`(?:amig[oa]|contacto|conocid[oa]|cliente)\s+en\s+común`, String.raw`(?:me|nos)\s+(?:recomend\p{L}+|refiri\p{L}+|hablaron|comentaron|dijeron|pasaron|dieron)`,
      String.raw`hablan?\s+muy\s+bien`, String.raw`muy\s+recomendad[oa]s?`,
    ),
  },
  {
    id: 'praise', why: 'It praises the partner’s work or reputation, which is not on file.',
    pattern: phrase(
      String.raw`(?:impressed|inspired)\s+(?:by|with)`,
      String.raw`i\s+(?:really\s+)?(?:love|loved|like|liked|admire|admired|enjoy|enjoyed|appreciate|appreciated)\s+(?:your|the\s+way\s+you|how\s+you|what\s+you)`,
      String.raw`(?:big|huge|long[\s-]?time)\s+fan`,
      String.raw`your\s+(?:reputation|track\s+record|success|great\s+work|excellent\s+work|hard\s+work|reviews|ratings|achievements?|awards?|growth|expertise)`,
      String.raw`well[\s-]known`, 'renowned', String.raw`award[\s-]winning`, String.raw`top[\s-](?:rated|producing|producer|agent|performer|seller)`,
      String.raw`you(?:['’]re|\s+are)\s+(?:known|one\s+of|the\s+best|a\s+leader|doing\s+(?:great|amazing))`,
      String.raw`impresionad[oa]s?`, String.raw`me\s+impresionó`, 'admiro', 'admiramos', String.raw`me\s+encant[óa]`, String.raw`me\s+gust[óa]`,
      String.raw`su\s+(?:reputación|trayectoria|éxito|excelente\s+trabajo|gran\s+trabajo|reseñas|premios?|crecimiento|experiencia)`,
      String.raw`reconocid[oa]s?`, String.raw`galardonad[oa]s?`, String.raw`de\s+renombre`,
    ),
  },
  {
    id: 'knows', why: 'It claims to know something about the partner that is not on file.',
    pattern: phrase(
      String.raw`i\s+(?:know|understand|see|hear|gather|believe|imagine)\s+(?:that\s+)?(?:you|your)`, String.raw`(?:i|we)\s+(?:was|were|am|are)\s+told`, String.raw`according\s+to\s+your`,
      String.raw`your\s+(?:website|site|web\s+page|profile|listings?|posts?|page|blog|videos?|ads?|open\s+house|office|team|instagram|facebook|linkedin)`,
      String.raw`(?:sé|entiendo|veo|imagino|tengo\s+entendido)\s+que\s+(?:usted|su|sus|ustedes)`,
      String.raw`sus?\s+(?:sitio|página|perfil|anuncios?|publicación|publicaciones|videos?|oficina|equipo|instagram|facebook|linkedin|blog)`,
    ),
  },
  {
    id: 'track-record', why: 'It states a track record or a relationship that nobody entered.',
    pattern: phrase(
      String.raw`(?:hundreds|thousands|dozens|countless|scores)\s+of`, String.raw`we(?:['’]ve|\s+have)\s+(?:worked|helped|served|partnered)`, String.raw`(?:fellow|neighbor|neighbour)s?`,
      String.raw`(?:my|our)\s+(?:friend|colleague|partner|client)s?`, String.raw`many\s+(?:of\s+)?(?:your|our)`, String.raw`years?\s+(?:of\s+experience|in\s+business)`,
      String.raw`(?:cientos|miles|decenas|innumerables)\s+de`, String.raw`hemos\s+(?:ayudado|trabajado|atendido|colaborado)`, String.raw`vecin[oa]s?`, String.raw`colegas?`,
      String.raw`(?:mi|nuestr[oa])s?\s+(?:amig[oa]|colega|soci[oa]|cliente)s?`, String.raw`años\s+de\s+experiencia`,
    ),
  },
];

export interface FamiliarityIssue { id: string; why: string; excerpt: string }
/** Every phrase in `text` that claims knowledge of, or history with, the reader. Empty means none was found. */
export function findFamiliarityClaims(text: string): FamiliarityIssue[] {
  const out: FamiliarityIssue[] = [];
  for (const r of FAMILIARITY_RULES) {
    const m = r.pattern.exec(text);
    if (m) out.push({ id: r.id, why: r.why, excerpt: m[0].slice(0, 80) });
  }
  return out;
}

// ---------------------------------------------------------------- checks for a rewording (not used by the sender)
// Nothing below is called when an email is sent: the sequence sends the fixed wording above and nothing else. These are
// the checks a reworded body would have to pass before a person approved it. They are pattern rules, and a pattern rule
// can be worded around ("It was great connecting with you at the mixer" names no listed phrase), which is exactly why
// model-written text is never emailed unattended.
/** Longest body (greeting to signature) that is ever sent. The standard wording is well under it. */
export const PARTNER_BODY_MAX_CHARS = 1800;
const nonEmptyLines = (s: string) => s.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim()).length;
const URLS = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;

export type Personalised = { ok: true; body: string } | { ok: false; reason: string };
/**
 * Decides whether a body reworded by the AI may replace the standard one. It may when it is the same length of letter
 * (same paragraphs, no longer than the cap and not much longer than the original), links nowhere new, passes the
 * marketing claims guard, and claims nothing about the reader. Otherwise the caller sends the standard wording.
 * The protected-rewriting checks in src/lib/ai/protected.ts have already run by the time this is called.
 */
export function acceptPersonalised(base: string, candidate: string): Personalised {
  const body = candidate.replace(/\r\n?/g, '\n').trim();
  if (!body) return { ok: false, reason: 'the AI returned nothing' };
  if (body.length > PARTNER_BODY_MAX_CHARS || body.length > base.trim().length * 1.25 + 60) return { ok: false, reason: 'the AI wording is longer than allowed' };
  if (nonEmptyLines(body) !== nonEmptyLines(base)) return { ok: false, reason: 'the AI added or dropped a paragraph' };
  const known = new Set(base.match(URLS) ?? []);
  if ((body.match(URLS) ?? []).some((u) => !known.has(u))) return { ok: false, reason: 'the AI wording links somewhere new' };
  const claim = findMarketingClaims(body)[0];
  if (claim) return { ok: false, reason: `the AI wording makes a claim that is not allowed (${claim.why})` };
  const familiar = findFamiliarityClaims(body)[0];
  if (familiar) return { ok: false, reason: `the AI wording says something about the partner that is not on file (“${familiar.excerpt}”)` };
  return { ok: true, body };
}

/**
 * What a model would be asked to do. It is told the partner's category and the language, both from fixed lists, and
 * nothing the agency or anyone else typed: no place, no website text, no name, email or phone. Text an agency controls
 * would let it steer the wording.
 */
export function personalisationGoal(a: { category: PartnerCategory; lang: PartnerLang }): string {
  return [
    `Reword only the connecting sentences of this short business introduction so it reads naturally to a reader in this line of work: ${PARTNER_CATEGORY_LABEL[a.category].toLowerCase()}.`,
    `Write in ${a.lang === 'es' ? 'Spanish, addressing the reader as usted' : 'plain English'}. Keep every paragraph, keep it the same length or shorter, and keep the greeting and the sign-off.`,
    'Do not say or imply that you know the reader, their business, their customers, their area or anything they have done, and do not mention any earlier contact, a recommendation, praise, numbers or a track record.',
  ].join(' ');
}
