/**
 * What a dispute page may OFFER after a result of "verified as reported", or when no response has been recorded by the
 * end of the reinvestigation period. Pure rules: they describe options, they never act, and nothing is automatic.
 *
 * Every option says what it is and what it is not. None of them predicts a result, none asks for a deletion, and none
 * is offered for an item the client has confirmed is reported accurately. "Generally" is used on purpose: this is
 * information about the usual rule, not legal advice about one case.
 *
 * Sources: 15 U.S.C. § 1681i (https://www.law.cornell.edu/uscode/text/15/1681i); Regulation V, 12 CFR § 1022.43
 * (https://www.ecfr.gov/current/title-12/chapter-X/part-1022); the CFPB complaint process
 * (https://www.consumerfinance.gov/complaint/process/).
 */
import { assertNoBlockedClaims } from '../compliance/claims';
import { MAIL_ALLOWANCE_DAYS, noResponseAfter, RESULTS_NOTICE_BUSINESS_DAYS, toDay, type Day } from './clock';

export type EscalationBasis = 'verified' | 'no_response';
export type StepKey = 'procedure_request' | 'results_request' | 'consumer_statement' | 'furnisher_dispute' | 'cfpb_complaint';

export interface EscalationInput {
  targetType: string;
  category: string;
  status: string;
  outcome: string | null;
  dueAt: string | null;
  /** disputes.client_confirmed_accurate */
  confirmedAccurate: boolean;
  /** True when the dispute is about an account on a report (disputes.tradeline_id is set). */
  hasTradeline: boolean;
  /** The zone the agency works in: the stored deadline is read as a day there. */
  tz?: string;
}

export interface EscalationStep {
  key: StepKey;
  title: string;
  /** One sentence on what it is. */
  is: string;
  /** One sentence on what it is not. */
  isNot: string;
  cite: string;
}

/**
 * Shown when the reinvestigation period has ended with no response recorded. It describes the record, not the agency:
 * the response may have arrived and simply not been entered, so it asks for that to be checked first.
 */
export const NO_RESPONSE_COPY = {
  title: 'No response recorded',
  body: `The reinvestigation period ended and ${RESULTS_NOTICE_BUSINESS_DAYS} business days plus ${MAIL_ALLOWANCE_DAYS} days for the mail have gone by. Check the mail, the agency’s online account and the client’s messages first. A response may have arrived and not been recorded here; if it has, record it above.`,
} as const;

export const CFPB_COMPLAINT_URL = 'https://www.consumerfinance.gov/complaint/';

/** Only disputes sent to a consumer reporting agency (a bureau or a specialty agency) run on the § 1681i clock. */
export const isAgencyDispute = (targetType: string) => targetType === 'bureau' || targetType === 'agency';

/**
 * Which situation the dispute is in, if either.
 *  - 'verified': a response of "verified as reported" is recorded.
 *  - 'no_response': no response is recorded and the day in noResponseAfter() has passed: the end of the period, plus
 *    the 5 business days the agency generally has to send written results (15 U.S.C. § 1681i(a)(6)(A)), plus a mail
 *    allowance. (Or "no response" was recorded by staff.) This says nothing about what the agency did: the response
 *    may simply not have been entered, and the app cannot know about an extension the agency took.
 */
export function escalationBasis(i: EscalationInput, today: Day): EscalationBasis | null {
  if (!isAgencyDispute(i.targetType)) return null;
  if (i.outcome === 'verified' && (i.status === 'response_received' || i.status === 'resolved')) return 'verified';
  if (i.outcome === 'no_response' && (i.status === 'response_received' || i.status === 'resolved')) return 'no_response';
  if ((i.status === 'submitted' || i.status === 'under_investigation') && !i.outcome && !!i.dueAt && noResponseAfter(toDay(i.dueAt, i.tz)) < today) return 'no_response';
  return null;
}

/**
 * 12 CFR § 1022.43(b)(1): a direct dispute generally does not cover identifying information, inquiries or information
 * derived from public records. Those have no account on the report either, so the step is offered only for a dispute
 * about a reported account (hasTradeline), and never for the two categories below.
 */
const NO_DIRECT_DISPUTE = new Set(['personal_info', 'unauthorized_inquiry']);

const STEPS: Record<StepKey, Omit<EscalationStep, 'key'>> = {
  procedure_request: {
    title: 'Ask how the information was verified',
    is: 'A written request to the agency for a description of the procedure it used in its reinvestigation, including the business name and address of any furnisher it contacted; the agency generally has 15 days from receiving the request to provide it.',
    isNot: 'It is a request for information. It is not a new dispute and does not by itself change the report.',
    cite: '15 U.S.C. § 1681i(a)(6)(B)(iii) and (a)(7)',
  },
  results_request: {
    title: 'Ask for the results in writing',
    is: 'A follow-up letter asking the agency for a written status and the results of its reinvestigation of this dispute.',
    isNot: 'It does not say the agency missed a deadline, and it is not a new dispute. Asking how the information was verified becomes available once a result is recorded.',
    cite: '15 U.S.C. § 1681i(a)(6)',
  },
  consumer_statement: {
    title: 'Add a consumer statement',
    is: 'When a reinvestigation does not resolve a dispute, the client may generally file a brief statement in their own words explaining it, and the agency includes the statement or a clear summary of it with the item in later reports (the agency may limit it to 100 words if it helps the client write it).',
    isNot: 'It does not change how the item is reported; it is the client’s own account placed beside it.',
    cite: '15 U.S.C. § 1681i(b) and (c)',
  },
  furnisher_dispute: {
    title: 'The client disputes directly with the company that reports it',
    is: 'The client may send their own dispute to the furnisher at the address it gives for disputes, identifying the account, the specific information disputed and the basis, with copies of supporting documents.',
    isNot: 'It is not a letter from this office: a furnisher generally need not investigate a dispute it reasonably believes was submitted by, prepared by, or sent on a form supplied by a credit repair organization, so the letter is the client’s own, written, signed and sent by the client.',
    cite: 'Regulation V, 12 CFR § 1022.43',
  },
  cfpb_complaint: {
    title: 'The client files a complaint with the CFPB',
    is: 'The client may submit a complaint about a consumer reporting company at consumerfinance.gov/complaint; the CFPB forwards it to the company, which generally responds within 15 days.',
    isNot: 'It is not filed by this office and it is not a court case: the client files it themselves, in their own words. Only a plain summary of the recorded dates and facts is prepared here for them to use.',
    cite: 'consumerfinance.gov/complaint',
  },
};

/**
 * The optional steps for a dispute, or null when none is offered: the dispute is not with a reporting agency, it is in
 * neither situation, or the client has confirmed the item is reported accurately.
 */
export function escalationSteps(i: EscalationInput, today: Day): { basis: EscalationBasis; steps: EscalationStep[] } | null {
  if (i.confirmedAccurate) return null;
  const basis = escalationBasis(i, today);
  if (!basis) return null;
  // A description of the procedure and a consumer statement both follow a completed reinvestigation, so with no
  // response recorded the first step is to ask for the results instead.
  const keys: StepKey[] = basis === 'verified' ? ['procedure_request', 'consumer_statement'] : ['results_request'];
  if (i.targetType === 'bureau' && i.hasTradeline && !NO_DIRECT_DISPUTE.has(i.category)) keys.push('furnisher_dispute');
  keys.push('cfpb_complaint');
  return { basis, steps: keys.map((key) => ({ key, ...STEPS[key] })) };
}

// ---------------------------------------------------------------- summary for the client's own CFPB complaint

export interface ComplaintFacts {
  company: string;
  item: string;
  /** What was disputed, in the words already on the dispute. */
  reason: string;
  sentOn: Day | null;
  sentMethod: string | null;
  tracking: string | null;
  receivedOn: Day | null;
  periodDays: number;
  periodEndsOn: Day | null;
  responseOn: Day | null;
  /** The recorded outcome in plain words ("verified as reported"), or null when no response is recorded. */
  outcomeText: string | null;
  procedureRequestSentOn: Day | null;
  procedureReplyOn: Day | null;
  today: Day;
}

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function longDay(day: Day, lang: 'en' | 'es'): string {
  const d = new Date(`${day}T00:00:00Z`);
  return lang === 'es' ? `${d.getUTCDate()} de ${MONTHS_ES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`
    : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

const METHOD: Record<string, { en: string; es: string }> = {
  certified_mail: { en: 'certified mail', es: 'correo certificado' }, first_class_mail: { en: 'first-class mail', es: 'correo de primera clase' },
  portal: { en: 'the company’s online portal', es: 'el portal en línea de la empresa' }, manual: { en: 'another method', es: 'otro medio' },
};

/**
 * A plain list of the dates and facts on record, for the CLIENT to use when they file their own complaint at
 * consumerfinance.gov/complaint. It states what was recorded and nothing else: no conclusion about what the company
 * did or did not do, no request for a particular result. Anything not recorded is said to be not recorded.
 */
export function complaintSummary(f: ComplaintFacts, lang: 'en' | 'es' = 'en'): string {
  const es = lang === 'es';
  const day = (d: Day | null) => (d ? longDay(d, lang) : es ? 'no registrada' : 'not recorded');
  const method = f.sentMethod && METHOD[f.sentMethod] ? METHOD[f.sentMethod]![lang] : null;
  const lines = es ? [
    'Resumen de fechas y hechos registrados (revise cada línea antes de usarlo; usted presenta la queja con sus propias palabras)',
    '',
    `Empresa: ${f.company}`,
    `Dato disputado: ${f.item}`,
    `Disputa enviada: ${day(f.sentOn)}${method ? ` (${method}${f.tracking ? `, referencia ${f.tracking}` : ''})` : ''}`,
    `Recibida por la empresa: ${day(f.receivedOn)}`,
    `Fin del plazo de reinvestigación de ${f.periodDays} días contado desde la recepción: ${day(f.periodEndsOn)}`,
    ...(f.responseOn ? [`Respuesta recibida: ${day(f.responseOn)}${f.outcomeText ? ` (${f.outcomeText})` : ''}`] : [
      `Respuesta: ninguna registrada al ${longDay(f.today, lang)}`,
      `Nota: la empresa generalmente tiene hasta ${RESULTS_NOTICE_BUSINESS_DAYS} días hábiles después de completar su reinvestigación para enviar los resultados por escrito, así que una respuesta puede llegar después de esa fecha.`,
    ]),
    ...(f.procedureRequestSentOn ? [`Solicitud de la descripción del procedimiento de reinvestigación enviada: ${day(f.procedureRequestSentOn)}`, `Descripción recibida: ${day(f.procedureReplyOn)}`] : []),
    '',
    'Lo que disputé:',
    f.reason.trim(),
  ] : [
    'Summary of recorded dates and facts (check every line before using it; you file the complaint in your own words)',
    '',
    `Company: ${f.company}`,
    `Item disputed: ${f.item}`,
    `Dispute sent: ${day(f.sentOn)}${method ? ` (${method}${f.tracking ? `, reference ${f.tracking}` : ''})` : ''}`,
    `Received by the company: ${day(f.receivedOn)}`,
    `End of the ${f.periodDays}-day reinvestigation period counted from receipt: ${day(f.periodEndsOn)}`,
    ...(f.responseOn ? [`Response received: ${day(f.responseOn)}${f.outcomeText ? ` (${f.outcomeText})` : ''}`] : [
      `Response: none recorded as of ${longDay(f.today, lang)}`,
      `Note: the company generally has up to ${RESULTS_NOTICE_BUSINESS_DAYS} business days after it completes its reinvestigation to send written results, so a response can arrive after that date.`,
    ]),
    ...(f.procedureRequestSentOn ? [`Request for the description of the reinvestigation procedure sent: ${day(f.procedureRequestSentOn)}`, `Description received: ${day(f.procedureReplyOn)}`] : []),
    '',
    'What I disputed:',
    f.reason.trim(),
  ];
  // Generated text that leaves the office: it goes through the same guard as every letter.
  return assertNoBlockedClaims(lines.join('\n'));
}

export const OUTCOME_PLAIN: Record<string, { en: string; es: string }> = {
  deleted: { en: 'the item was deleted', es: 'el dato fue eliminado' }, updated: { en: 'the item was updated', es: 'el dato fue actualizado' },
  verified: { en: 'verified as reported', es: 'verificado tal como se informa' }, unresolved: { en: 'not resolved', es: 'sin resolver' },
  frivolous: { en: 'the company said it needed more information to investigate', es: 'la empresa indicó que necesitaba más información para investigar' },
};
