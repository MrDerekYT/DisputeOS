/**
 * Text messages in the automatic follow-up to people who sent an agency's enquiry form. Pure: no database, no network.
 *
 * A text is marketing, so it is only ever sent to a lead who ticked the separate text-message box on the form: that is
 * a written consent naming the business and saying the messages are automated, and its exact wording is stored with
 * the consent record (sms_consents, source 'enquiry_form'). No box ticked, no text: the lead gets email only.
 * A consent recorded by staff or in the portal is for updates about a client's file and never unlocks these texts.
 * Wording rules: name the sender, never promise a result, never carry detail about the person, always say how to stop.
 */
import { LEAD_WINDOW_DAYS } from './lead-emails';
import { usAreaCodeState } from './us-phone';

export const LEAD_TEXT_STEPS = [
  { key: 'text_welcome', afterDays: 0, label: 'Welcome text' },
  { key: 'text_followup', afterDays: 3, label: 'Follow-up text' },
] as const;
export type LeadTextStep = (typeof LEAD_TEXT_STEPS)[number]['key'];
export const LEAD_TEXT_STEP_KEYS: readonly string[] = LEAD_TEXT_STEPS.map((s) => s.key);
/** Never two automatic texts closer together than this. */
export const LEAD_TEXT_MIN_GAP_DAYS = 2;
/** sms_consents.source for a consent given on the public enquiry form. */
export const ENQUIRY_FORM_CONSENT = 'enquiry_form';
/**
 * Most follow-up texts one agency sends to leads in any 24 hours. An agency that really gets more enquiries than this
 * in a day can raise it with the operator; a form being fed numbers by a script stops here. Every text that was
 * claimed counts, also one that failed or that the carrier reported undelivered.
 */
export const LEAD_TEXT_DAILY_CAP = 40;

type Lang = 'en' | 'es';
const cleanOrg = (name: string, max: number) => name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();

// ---------------------------------------------------------------- the consent a person gives on the form
const CONSENT: Record<Lang, string> = {
  en: 'I agree to receive automated text messages from {org} at the mobile number I entered above, about my enquiry, the services {org} offers and, if I become a client, my file. Agreeing is not a condition of buying anything. Message frequency varies. Message and data rates may apply. Reply STOP to stop, HELP for help.',
  es: 'Acepto recibir mensajes de texto automatizados de {org} en el número de celular que escribí arriba, sobre mi consulta, los servicios que ofrece {org} y, si llego a ser cliente, mi expediente. Aceptar no es una condición para comprar nada. La frecuencia de los mensajes varía. Pueden aplicarse tarifas de mensajes y datos. Responda STOP para dejar de recibirlos, HELP para ayuda.',
};
/**
 * The wording beside the optional, unticked text-message box on the enquiry form, in the language the form is shown
 * in. It is separate from the "you may contact me" box, and this exact text is what is stored with the consent.
 */
export const leadSmsConsentText = (lang: Lang, orgName: string) => CONSENT[lang === 'es' ? 'es' : 'en'].replaceAll('{org}', () => cleanOrg(orgName, 100));

/** Shown when the box is ticked but the phone field cannot be read as a US mobile number (texts go to US numbers only). */
export const LEAD_SMS_NEEDS_PHONE: Record<Lang, string> = {
  en: 'To get text messages, enter a US mobile number with its area code, such as (212) 555-0142, or untick the text message box.',
  es: 'Para recibir mensajes de texto, escriba un número de celular de EE. UU. con su código de área, como (212) 555-0142, o desmarque la casilla de mensajes de texto.',
};

/**
 * A business name that would put a web address in a text (or in an email subject): "Acme chase-verify.example". The
 * name is the first thing in every automatic message, so one that carries a link turns each message into the link.
 * Returns the offending part, or null. An ordinary name with a full stop ("St. Mary Credit", "A.B. Smith & Co.") passes.
 */
export function linkInName(name: string): string | null {
  return /(?:https?:\/\/|www\.)\S+|\b[\p{L}\p{N}][\p{L}\p{N}-]*\.(?:[\p{L}\p{N}-]+\.)*\p{L}{2,}\b/iu.exec(name)?.[0] ?? null;
}

// ---------------------------------------------------------------- which text is due
export interface LeadTextState {
  status: string;
  /** Ticked "you may contact me" on the enquiry form. */
  consented: boolean;
  /** Used the opt-out link in an email, or asked the team to stop: no automatic message of any kind after that. */
  optedOut: boolean;
  replied: boolean;
  contacted: boolean;
  /** The number the enquiry-form text consent in force was given for, or null when there is none. */
  consentPhone: string | null;
  /** The number on the lead's record today, in E.164, or null when it cannot be read as one. */
  phone: string | null;
  receivedAt: Date | string;
  eligibleFrom?: Date | string | null;
  texts: { step: string; status: string; at: Date | string }[];
}
export type LeadTextStopReason = 'not_lead' | 'opted_out' | 'no_consent' | 'number_changed' | 'not_us_number' | 'replied' | 'contacted' | 'before_switch' | 'done' | 'failed' | 'unconfirmed' | 'expired';
export type LeadTextDecision = { kind: 'send'; step: LeadTextStep } | { kind: 'wait'; step: LeadTextStep; dueAt: Date } | { kind: 'stop'; reason: LeadTextStopReason };

const DAY = 86_400_000;
const stop = (reason: LeadTextStopReason): LeadTextDecision => ({ kind: 'stop', reason });

/**
 * Which automatic text, if any, a lead should get now. Same stop rules as the automatic emails, plus the consent:
 * a text needs an enquiry-form text consent in force for exactly the number on the record, and that number has to be a
 * US one. A failed or unconfirmed text is never sent again. Quiet hours are applied by the sender, which knows the zones.
 */
export function decideLeadText(s: LeadTextState, now: Date = new Date()): LeadTextDecision {
  if (s.status !== 'lead') return stop('not_lead');
  if (s.optedOut) return stop('opted_out');
  if (!s.consented || !s.consentPhone) return stop('no_consent');
  if (!s.phone || s.phone !== s.consentPhone) return stop('number_changed');
  // A marketing text only ever goes to a US number whose area code we know: it says where the person may be (quiet
  // hours), and nothing else under "+1" or abroad is texted at all.
  if (!usAreaCodeState(s.consentPhone)) return stop('not_us_number');
  if (s.replied) return stop('replied');
  if (s.contacted) return stop('contacted');
  const received = new Date(s.receivedAt).getTime();
  if (!s.eligibleFrom || !(received >= new Date(s.eligibleFrom).getTime())) return stop('before_switch');
  if (s.texts.some((t) => t.status === 'sending')) return stop('unconfirmed');
  if (s.texts.some((t) => t.status === 'failed')) return stop('failed');
  const sent = s.texts.filter((t) => t.status === 'sent');
  const next = LEAD_TEXT_STEPS.find((st) => !sent.some((t) => t.step === st.key));
  if (!next) return stop('done');
  if (now.getTime() - received > LEAD_WINDOW_DAYS * DAY) return stop('expired');
  const lastSent = Math.max(0, ...sent.map((t) => new Date(t.at).getTime()));
  const dueAt = new Date(Math.max(received + next.afterDays * DAY, lastSent ? lastSent + LEAD_TEXT_MIN_GAP_DAYS * DAY : 0));
  return now.getTime() >= dueAt.getTime() ? { kind: 'send', step: next.key } : { kind: 'wait', step: next.key, dueAt };
}

// ---------------------------------------------------------------- wording
const TEXT: Record<LeadTextStep, Record<Lang, string>> = {
  text_welcome: {
    en: '{org}: Thanks for your enquiry. Someone from our team will contact you soon. You can reply to this text with a good time to reach you. Reply STOP to stop, HELP for help.',
    es: '{org}: Gracias por su consulta. Alguien de nuestro equipo se comunicará con usted pronto. Puede responder a este mensaje con un buen momento para comunicarnos. Responda STOP para no recibir más mensajes, HELP para ayuda.',
  },
  text_followup: {
    en: '{org}: We are still glad to talk about your enquiry whenever it suits you. Reply to this text with a good time to reach you. Reply STOP to stop, HELP for help.',
    es: '{org}: Con gusto seguimos disponibles para conversar sobre su consulta cuando le convenga. Responda a este mensaje con un buen momento para comunicarnos. Responda STOP para no recibir más mensajes, HELP para ayuda.',
  },
};

/** The text for one step. It names the agency and says how to stop; it carries nothing about the person or their credit. */
export const leadText = (step: LeadTextStep, lang: Lang, v: { orgName: string }) => TEXT[step][lang === 'es' ? 'es' : 'en'].replace('{org}', () => cleanOrg(v.orgName, 40));
