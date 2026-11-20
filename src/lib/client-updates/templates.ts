/**
 * Client updates by text message and email: the events, the wording, the agency's switches and the quiet-hours rule.
 * Pure: no database, no environment. The sending lives in ./service.ts.
 *
 * Wording rules (the tests hold every template to them):
 *  - A text never carries anything about the file itself: no account or company name, no number, no balance, no
 *    outcome. It only says there is something to see and gives the portal link. A phone's lock screen is not private.
 *  - An email may name the stage ("a dispute was sent", "a response came back") but still no account detail.
 *  - Nothing promises or predicts a result, and nothing states a legal rule as fact ("generally").
 *  - Every text names the sender and says how to stop.
 */
export type UpdateLang = 'en' | 'es';
export type UpdateChannel = 'sms' | 'email';
export const UPDATE_CHANNELS: UpdateChannel[] = ['sms', 'email'];

export const UPDATE_EVENTS = ['dispute_sent', 'response_recorded', 'document_needed', 'document_rejected', 'window_passed', 'team_message'] as const;
export type UpdateEvent = (typeof UPDATE_EVENTS)[number];

/** Staff-facing label and one line on when it goes out (Settings → Client updates). */
export const UPDATE_EVENT_LABEL: Record<UpdateEvent, { label: string; when: string }> = {
  dispute_sent: { label: 'Dispute sent', when: 'When a dispute is recorded as sent.' },
  response_recorded: { label: 'Response recorded', when: 'When a response is recorded on a dispute.' },
  document_needed: { label: 'Document needed', when: 'When you request a document. At most once a day per client.' },
  document_rejected: { label: 'Document rejected', when: 'When you reject a document the client sent.' },
  window_passed: { label: 'No response recorded', when: 'When the investigation period, the 5 business days the agency generally has to send results and a week for the mail have all passed with no response recorded.' },
  team_message: { label: 'New message from the team', when: 'When you send a portal message. At most once an hour per client.' },
};

// ---------------------------------------------------------------- the agency's switches
/** Stored at organizations.settings.client_updates. Everything is off until an owner or admin turns it on. */
export interface UpdateSettings {
  switches: Record<UpdateEvent, Record<UpdateChannel, boolean>>;
  /** When "no response in time" was last switched on: windows that ended before it are never announced after the fact. */
  windowSince: string | null;
}
export function updateSettings(orgSettings: Record<string, unknown> | null | undefined): UpdateSettings {
  const raw = (orgSettings?.client_updates ?? {}) as { switches?: Record<string, Record<string, unknown>>; window_since?: unknown };
  const switches = Object.fromEntries(UPDATE_EVENTS.map((e) => [e, { sms: raw.switches?.[e]?.sms === true, email: raw.switches?.[e]?.email === true }])) as UpdateSettings['switches'];
  return { switches, windowSince: typeof raw.window_since === 'string' && !Number.isNaN(Date.parse(raw.window_since)) ? raw.window_since : null };
}
export const anyChannelOn = (s: UpdateSettings, event: UpdateEvent) => s.switches[event].sms || s.switches[event].email;

// ---------------------------------------------------------------- what a text needs beyond the switch and the consent
/**
 * Sign-up is open and every text leaves through the deployment's one sending number, so no client update is texted for
 * a workspace until the platform operator has approved it under the name it has now (src/lib/outreach-approval.ts).
 * Emails of client updates do not need the approval. This is what staff are told where the state of texts is shown.
 */
export const TEXTS_NEED_APPROVAL: Record<'not_approved' | 'renamed', string> = {
  not_approved: 'No text is being sent from this workspace: the platform operator has not approved it for text messages yet. Client updates by email are not affected.',
  renamed: 'No text is being sent from this workspace: your business name changed after the platform operator approved it for text messages. The name starts every text, so the operator has to approve it again. Client updates by email are not affected.',
};
/** Why a queued text was not sent, as recorded on its row and listed under Settings → Client updates. */
export const TEXT_NOT_APPROVED = 'The workspace is not approved for text messages';
export const TEXT_NOT_US_NUMBER = 'Not a US mobile number: texts are sent to US numbers only';

// ---------------------------------------------------------------- limits
/**
 * Texts go out between 8:00 and 21:00 and wait in the queue outside that.
 * 47 CFR § 64.1200(c)(1) sets 8 a.m. to 9 p.m. "local time at the called party's location" for telephone
 * solicitations. These updates are service messages, not solicitations, so this is a courtesy rule and not a statement
 * that the regulation applies. It is still judged where the CLIENT is, as far as the record says:
 *  - the workspace's own time zone (organizations.settings.timezone; the deployment's APP_TIMEZONE until one is chosen), and
 *  - every time zone of the US state on the client's address (a state that spans two zones counts in both);
 *  - with no usable state on the address, both Eastern and Pacific, which keeps texts to 11:00-21:00 Eastern.
 * A text is sent only when it is inside the window in ALL of those zones, i.e. the narrowest window.
 */
export const QUIET_START_HOUR = 21;
export const QUIET_END_HOUR = 8;
/** The hours a message may go out in, local time: from `from`:00 up to, but not including, `until`:00. */
export interface SendWindow { from: number; until: number }
/** Service updates to clients: 8:00 to 21:00. */
export const UPDATE_WINDOW: SendWindow = { from: QUIET_END_HOUR, until: QUIET_START_HOUR };
/**
 * Marketing texts (the follow-up to people who sent the enquiry form): 9:00 to 20:00, an hour inside the 8 a.m. to
 * 9 p.m. that 47 CFR § 64.1200(c)(1) sets for telephone solicitations, so that an hour's doubt about where the person
 * is never puts a text outside it.
 */
export const MARKETING_WINDOW: SendWindow = { from: 9, until: 20 };
export function hourInZone(now: Date, tz: string): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now);
  return Number(h) % 24;
}
export function inQuietHours(now: Date, tz: string, window: SendWindow = UPDATE_WINDOW): boolean {
  const h = hourInZone(now, tz);
  return h >= window.until || h < window.from;
}
export const inQuietHoursAnywhere = (now: Date, zones: string[], window: SendWindow = UPDATE_WINDOW) => zones.some((z) => inQuietHours(now, z, window));

/** The zones a workspace can choose (Settings → Client updates). IANA names; daylight time is handled by the runtime. */
export const US_ZONES: { value: string; label: string }[] = [
  { value: 'America/New_York', label: 'Eastern' }, { value: 'America/Chicago', label: 'Central' }, { value: 'America/Denver', label: 'Mountain' },
  { value: 'America/Phoenix', label: 'Arizona (no daylight time)' }, { value: 'America/Los_Angeles', label: 'Pacific' }, { value: 'America/Anchorage', label: 'Alaska' },
  { value: 'Pacific/Honolulu', label: 'Hawaii' }, { value: 'America/Puerto_Rico', label: 'Atlantic (Puerto Rico)' },
];
/** organizations.settings.timezone when it is one of US_ZONES, otherwise the deployment default. */
export function orgTimezone(orgSettings: Record<string, unknown> | null | undefined, fallback: string): string {
  const v = orgSettings?.timezone;
  return typeof v === 'string' && US_ZONES.some((z) => z.value === v) ? v : fallback;
}

const [ET, CT, MT, PT] = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'];
const zonesOf = (zones: string[], states: string) => Object.fromEntries(states.split(' ').map((st) => [st, zones]));
/**
 * Every time zone observed in each US state and territory, by postal abbreviation. A state split between two zones
 * lists both, so the window is the overlap. (Time zone boundaries: 49 CFR part 71.)
 */
export const STATE_ZONES: Record<string, string[]> = {
  ...zonesOf([ET], 'CT DE DC GA ME MD MA NH NJ NY NC OH PA RI SC VT VA WV'),
  ...zonesOf([ET, CT], 'FL IN KY MI TN'),
  ...zonesOf([CT], 'AL AR IL IA LA MN MS MO OK WI'),
  ...zonesOf([CT, MT], 'KS NE ND SD TX'),
  ...zonesOf([MT], 'CO MT NM UT WY'),
  ...zonesOf([MT, PT], 'ID OR NV'),
  ...zonesOf([PT], 'CA WA'),
  AZ: ['America/Phoenix', MT], // the Navajo Nation observes daylight time
  AK: ['America/Anchorage', 'America/Adak'], HI: ['Pacific/Honolulu'],
  PR: ['America/Puerto_Rico'], VI: ['America/Puerto_Rico'], GU: ['Pacific/Guam'], MP: ['Pacific/Guam'], AS: ['Pacific/Pago_Pago'],
};
/** The zones a text to one client is judged in: the workspace's, plus the client's state (or Eastern and Pacific when the state is not known). */
export function quietZones(orgTz: string, clientState: string | null | undefined): string[] {
  const st = (clientState ?? '').trim().toUpperCase();
  return [...new Set([orgTz, ...(STATE_ZONES[st] ?? [ET, PT])])];
}
/**
 * The zones a text to a LEAD is judged in. The enquiry form collects no address, so the number is the only thing that
 * says where the person may be: the zones of the state its area code belongs to (`areaState`, from src/lib/us-phone.ts)
 * are added to the workspace's own zone and to Eastern and Pacific (or the state on the record, when there is one).
 * A number keeps its area code when its owner moves, which is why the others stay in: the text goes out only when it is
 * inside the window in every one of them.
 */
export function leadQuietZones(orgTz: string, recordState: string | null | undefined, areaState: string): string[] {
  return [...new Set([...quietZones(orgTz, recordState), ...(STATE_ZONES[areaState] ?? [])])];
}

/** Most messages one client gets on one channel in any 24 hours. Anything past it is skipped, not saved up. */
export const DAILY_CAP: Record<UpdateChannel, number> = { sms: 3, email: 6 };
/** A queued message older than this is dropped instead of sent: "there is an update" days later helps nobody. */
export const MAX_QUEUE_AGE_HOURS = 72;
/** Longest text sent (two SMS segments of plain characters). */
export const SMS_MAX_CHARS = 320;

// ---------------------------------------------------------------- wording
type Text = Record<UpdateLang, string>;

const SMS_LINE: Record<UpdateEvent, Text> = {
  dispute_sent: { en: 'There is an update on your file.', es: 'Hay una novedad en su expediente.' },
  response_recorded: { en: 'There is an update on your file.', es: 'Hay una novedad en su expediente.' },
  window_passed: { en: 'There is an update on your file.', es: 'Hay una novedad en su expediente.' },
  document_needed: { en: 'We need something from you.', es: 'Necesitamos algo de usted.' },
  document_rejected: { en: 'We need something from you.', es: 'Necesitamos algo de usted.' },
  team_message: { en: 'You have a new message from your team.', es: 'Tiene un mensaje nuevo de su equipo.' },
};
const SMS_FRAME: Text = {
  en: '{org}: {line} Sign in to see it: {url} Reply STOP to stop, HELP for help.',
  es: '{org}: {line} Inicie sesión para verlo: {url} Responda STOP para no recibir más mensajes, HELP para ayuda.',
};

const EMAIL: Record<UpdateEvent, { subject: Text; body: Text }> = {
  dispute_sent: {
    subject: { en: 'A dispute was sent for you', es: 'Enviamos una disputa en su nombre' },
    body: {
      en: 'We sent a dispute for you. The company that receives it generally has about 30 days to investigate, and in some cases longer. Sign in to your portal to see which item it is and where it stands.',
      es: 'Enviamos una disputa en su nombre. La empresa que la recibe generalmente tiene unos 30 días para investigar, y en algunos casos más. Inicie sesión en su portal para ver de qué partida se trata y en qué estado está.',
    },
  },
  response_recorded: {
    subject: { en: 'A response came back on one of your items', es: 'Llegó una respuesta sobre una de sus partidas' },
    body: {
      en: 'We received a response on one of your items and recorded it in your file. Sign in to your portal to read it and see what happens next.',
      es: 'Recibimos una respuesta sobre una de sus partidas y la registramos en su expediente. Inicie sesión en su portal para leerla y ver qué sigue.',
    },
  },
  document_needed: {
    subject: { en: 'We need a document from you', es: 'Necesitamos un documento de usted' },
    body: {
      en: 'We asked you for a document so we can keep working on your file. Sign in to your portal to see what we need. You can upload it there, even from your phone.',
      es: 'Le pedimos un documento para poder seguir trabajando en su expediente. Inicie sesión en su portal para ver qué necesitamos. Puede subirlo allí, incluso desde su teléfono.',
    },
  },
  document_rejected: {
    subject: { en: 'A document needs to be sent again', es: 'Hay que volver a enviar un documento' },
    body: {
      en: 'We could not use a document you sent us. Sign in to your portal to see which one and why, and to upload another.',
      es: 'No pudimos usar un documento que nos envió. Inicie sesión en su portal para ver cuál y por qué, y para subir otro.',
    },
  },
  window_passed: {
    subject: { en: 'No response yet on one of your items', es: 'Aún no hay respuesta sobre una de sus partidas' },
    body: {
      en: 'The usual time to investigate one of your items has passed and we have not recorded a response yet. Sign in to your portal to see where it stands or to message your team.',
      es: 'Ya pasó el plazo habitual para investigar una de sus partidas y todavía no hemos registrado una respuesta. Inicie sesión en su portal para ver en qué estado está o para escribirle a su equipo.',
    },
  },
  team_message: {
    subject: { en: 'You have a new message', es: 'Tiene un mensaje nuevo' },
    body: {
      en: 'Your team sent you a message. Sign in to your portal to read it and reply.',
      es: 'Su equipo le envió un mensaje. Inicie sesión en su portal para leerlo y responder.',
    },
  },
};
const EMAIL_FRAME: Text = {
  en: 'Hello {first},\n\n{body}\n\n{url}\n\n{org}\n\nThis is a service message about your file with {org}. Results vary, and every decision is made by the credit bureaus and the companies that report to them.',
  es: 'Hola {first}:\n\n{body}\n\n{url}\n\n{org}\n\nEste es un mensaje de servicio sobre su expediente con {org}. Los resultados varían, y cada decisión la toman las agencias de crédito y las empresas que les reportan.',
};

const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
/** A business name as it may appear in a message: one line, no control characters, not long enough to crowd out the text. */
export const cleanOrgName = (name: string, max = 40) => name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();

export interface UpdateVars { orgName: string; portalUrl: string; firstName?: string }

/** The text for an event. The same few words whatever happened: the detail stays behind the sign-in. */
export function smsText(event: UpdateEvent, lang: UpdateLang, v: UpdateVars): string {
  return fill(SMS_FRAME[lang], { org: cleanOrgName(v.orgName), line: SMS_LINE[event][lang], url: v.portalUrl });
}

export function emailText(event: UpdateEvent, lang: UpdateLang, v: UpdateVars): { subject: string; text: string } {
  const org = cleanOrgName(v.orgName, 100);
  const first = cleanOrgName(v.firstName ?? '', 60).split(' ')[0] || (lang === 'es' ? 'cliente' : 'there');
  return { subject: EMAIL[event].subject[lang], text: fill(EMAIL_FRAME[lang], { first, body: EMAIL[event].body[lang], url: v.portalUrl, org }) };
}
