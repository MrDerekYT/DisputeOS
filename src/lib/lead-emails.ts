/**
 * Automatic follow-up to people who sent an agency's enquiry form and agreed to be contacted. Pure: no database, no
 * network. Wording rules: say what the agency does, never promise a result, and always say how to stop the emails.
 */
export const LEAD_STEPS = [
  { key: 'welcome', afterDays: 0, label: 'Welcome' },
  { key: 'followup', afterDays: 2, label: 'Follow-up' },
  { key: 'final', afterDays: 6, label: 'Last note' },
] as const;
export type LeadStep = (typeof LEAD_STEPS)[number]['key'];
/** Never two automatic emails closer together than this, even when the schedule is running late. */
export const LEAD_MIN_GAP_DAYS = 2;
/** An enquiry older than this gets no more automatic email: a late message about an old enquiry is unwelcome. */
export const LEAD_WINDOW_DAYS = 14;
export const LEAD_MAX_ATTEMPTS = 3;

/** Tags an agency can put on its form link (`?src=instagram`) to see where enquiries come from. */
export const LEAD_SOURCE_TAGS = ['instagram', 'facebook', 'tiktok', 'google', 'flyer', 'referral'] as const;
export const DEFAULT_LEAD_SOURCE = 'Website form';

/** A `?src=` value as stored: lowercase letters, digits and hyphens, at most 30 characters. Anything else is ignored. */
export function leadSourceTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return /^[a-z0-9-]{1,30}$/.test(v) ? v : null;
}

export interface LeadOutreachState {
  status: string;
  hasEmail: boolean;
  /** Ticked "you may contact me" on the enquiry form. Leads typed in by staff have not, and are never emailed automatically. */
  consented: boolean;
  optedOut: boolean;
  /** A message from the lead is on file: a portal message, or a reply the team logged with "They replied". Email replies go to the agency's own mailbox and are not read by this system. */
  replied: boolean;
  /** Anything a person on the team sent or logged (email, portal message, call or text note). Email that was not delivered does not count. */
  contacted: boolean;
  receivedAt: Date | string;
  /** Automatic follow-up only covers enquiries received after the agency switched it on. */
  eligibleFrom?: Date | string | null;
  outreach: { step: string; status: string; at: Date | string; attempts?: number }[];
}
export type LeadStopReason = 'not_lead' | 'opted_out' | 'no_consent' | 'no_email' | 'replied' | 'contacted' | 'before_switch' | 'done' | 'failed' | 'unconfirmed' | 'expired';
export type LeadDecision = { kind: 'send'; step: LeadStep } | { kind: 'wait'; step: LeadStep; dueAt: Date } | { kind: 'stop'; reason: LeadStopReason };

const DAY = 86_400_000;
const stop = (reason: LeadStopReason): LeadDecision => ({ kind: 'stop', reason });

/** Which automatic email, if any, a lead should get now. The single rule used by the job and by the Leads page. */
export function decideLeadStep(s: LeadOutreachState, now: Date = new Date()): LeadDecision {
  if (s.status !== 'lead') return stop('not_lead');
  if (s.optedOut) return stop('opted_out');
  if (!s.consented) return stop('no_consent');
  if (!s.hasEmail) return stop('no_email');
  if (s.replied) return stop('replied');
  if (s.contacted) return stop('contacted');
  const received = new Date(s.receivedAt).getTime();
  // `!(a >= b)` rather than `a < b`: an unreadable switch-on date must stop the email, never allow it.
  if (!s.eligibleFrom || !(received >= new Date(s.eligibleFrom).getTime())) return stop('before_switch');
  const sent = s.outreach.filter((o) => o.status === 'sent');
  const next = LEAD_STEPS.find((st) => !sent.some((o) => o.step === st.key));
  if (!next) return stop('done');
  // A step left at 'sending' was handed to the email service but never confirmed (a crash or a lost connection). It may or
  // may not have arrived, so it is never sent again automatically, and nothing later goes out on top of it.
  if (s.outreach.some((o) => o.status === 'sending')) return stop('unconfirmed');
  const prior = s.outreach.find((o) => o.step === next.key);
  if (prior && prior.status === 'failed' && (prior.attempts ?? 1) >= LEAD_MAX_ATTEMPTS) return stop('failed');
  if (now.getTime() - received > LEAD_WINDOW_DAYS * DAY) return stop('expired');
  const lastSent = Math.max(0, ...sent.map((o) => new Date(o.at).getTime()));
  const dueAt = new Date(Math.max(received + next.afterDays * DAY, lastSent ? lastSent + LEAD_MIN_GAP_DAYS * DAY : 0));
  return now.getTime() >= dueAt.getTime() ? { kind: 'send', step: next.key } : { kind: 'wait', step: next.key, dueAt };
}

/**
 * The name used in the greeting. The enquiry form is public and the address is not verified, so whatever was typed as a
 * name could end up in an email to a stranger. Only a plain first name is used (letters, apostrophes, hyphens, at most
 * 30 characters); anything else — a link, digits, symbols — gives '' and the email says "Hi there" instead.
 */
export function greetingName(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0] ?? '';
  return /^\p{L}[\p{L}'’-]{0,29}$/u.test(first) ? first : '';
}

export interface LeadEmailVars { firstName: string; orgName: string; address: string; optOutUrl: string }
export interface LeadEmail { subject: string; text: string }
type Copy = { subject: string; body: string[] };

const EN: Record<LeadStep, Copy> = {
  welcome: {
    subject: 'We received your enquiry — {org}',
    body: [
      'Hi {name},',
      'Thank you for contacting {org}. We received your enquiry, and someone from our team will reach out to you personally.',
      'What we do: we help you review your credit reports and dispute information that is inaccurate, incomplete or cannot be verified.',
      'What we cannot do: promise a result. Credit bureaus and lenders make their own decisions, so no one can honestly promise a specific outcome, an approval or a higher score, and accurate information stays on a report. You also have the right to dispute inaccurate information with the credit bureaus yourself, at no cost.',
      'If you would like to talk sooner, reply to this email with a good time to reach you. Please do not send your Social Security number or account numbers by email.',
    ],
  },
  followup: {
    subject: 'Still interested? A quick note from {org}',
    body: [
      'Hi {name},',
      'A couple of days ago you asked {org} about help with your credit. We do not want to crowd you; this is a short note to say we are still glad to talk.',
      'A first conversation is about understanding your situation: what is on your credit reports, what looks inaccurate, and whether our service makes sense for you. We will not promise a result, and you are free to decide it is not for you.',
      'To set up a time, reply to this email and tell us when to reach you.',
    ],
  },
  final: {
    subject: 'Last note from {org} about your enquiry',
    body: [
      'Hi {name},',
      'This is the last automatic message about the enquiry you sent to {org}. If now is not the right time, you do not need to do anything, and we will not keep emailing you.',
      'If you would still like to talk, reply to this email with a good time to reach you.',
      'Either way, you can get your credit reports free at AnnualCreditReport.com and dispute inaccurate information with the credit bureaus yourself at no cost.',
    ],
  },
};

const ES: Record<LeadStep, Copy> = {
  welcome: {
    subject: 'Recibimos su consulta — {org}',
    body: [
      'Hola {name}:',
      'Gracias por comunicarse con {org}. Recibimos su consulta y alguien de nuestro equipo se pondrá en contacto con usted personalmente.',
      'Lo que hacemos: le ayudamos a revisar sus informes de crédito y a disputar la información que sea inexacta, esté incompleta o no pueda verificarse.',
      'Lo que no podemos hacer: prometer un resultado. Las agencias de crédito y los prestamistas toman sus propias decisiones, así que nadie puede prometer honestamente un resultado específico, una aprobación ni un puntaje más alto, y la información exacta permanece en el informe. Usted también tiene derecho a disputar información inexacta directamente con las agencias de crédito, sin costo.',
      'Si prefiere hablar antes, responda a este correo con un buen momento para comunicarnos. Por favor, no envíe su número de Seguro Social ni números de cuenta por correo electrónico.',
    ],
  },
  followup: {
    subject: '¿Sigue interesado? Una nota breve de {org}',
    body: [
      'Hola {name}:',
      'Hace un par de días usted le preguntó a {org} sobre ayuda con su crédito. No queremos presionarle; esta es una nota breve para decirle que con gusto seguimos disponibles para conversar.',
      'Una primera conversación sirve para entender su situación: qué aparece en sus informes de crédito, qué parece inexacto y si nuestro servicio tiene sentido para usted. No le prometeremos un resultado, y usted es libre de decidir que no es para usted.',
      'Para coordinar una llamada, responda a este correo y díganos cuándo comunicarnos.',
    ],
  },
  final: {
    subject: 'Última nota de {org} sobre su consulta',
    body: [
      'Hola {name}:',
      'Este es el último mensaje automático sobre la consulta que envió a {org}. Si ahora no es el momento adecuado, no necesita hacer nada, y no le seguiremos escribiendo.',
      'Si todavía desea conversar, responda a este correo con un buen momento para comunicarnos.',
      'En cualquier caso, puede obtener sus informes de crédito gratis en AnnualCreditReport.com y disputar información inexacta directamente con las agencias de crédito, sin costo.',
    ],
  },
};

const FOOTER = {
  en: ['You are receiving this because you asked {org} to contact you through its enquiry form.', 'Stop these emails: {optOut}', 'A reply reaches our team, but it does not stop these automatic emails by itself. The link above does.'],
  es: ['Usted recibe este mensaje porque le pidió a {org} que se comunicara con usted mediante su formulario de consulta.', 'Dejar de recibir estos correos: {optOut}', 'Una respuesta llega a nuestro equipo, pero por sí sola no detiene estos correos automáticos. El enlace anterior sí.'],
};

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The full plain-text email for one step: body, agency name, postal address and the opt-out link. */
export function leadEmail(step: LeadStep, lang: 'en' | 'es', v: LeadEmailVars): LeadEmail {
  const copy = (lang === 'es' ? ES : EN)[step];
  const foot = FOOTER[lang === 'es' ? 'es' : 'en'];
  const org = oneLine(v.orgName);
  const name = greetingName(v.firstName) || (lang === 'es' ? 'qué tal' : 'there');
  const fill = (s: string) => s.replaceAll('{org}', org).replaceAll('{name}', name).replaceAll('{optOut}', v.optOutUrl);
  const text = [...copy.body, `— ${org}`, '--', foot[0]!, `${org} · ${oneLine(v.address)}`, foot[1]!, foot[2]!].map(fill).join('\n\n');
  return { subject: fill(copy.subject).slice(0, 200), text };
}
