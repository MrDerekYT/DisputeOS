/**
 * Letter templates. They state the sender's request and cite the statute that gives the right to make it — they do
 * NOT threaten, promise results, or characterise any item as inaccurate unless the sender wrote that in the reason.
 * Not legal advice; templates are starting points that a person reviews and edits. Have counsel review before use.
 */
import { AGENCY_KINDS, type AgencyKind } from '../credit/agencies';

export type LetterKind = 'bureau_dispute' | 'creditor_dispute' | 'validation_request' | 'collector_communication' | 'follow_up' | 'investigation_response' | 'personal_info_correction' | 'goodwill' | 'specialty_dispute' | 'method_of_verification';

export interface LetterTemplate {
  key: string; kind: LetterKind; language: 'en' | 'es'; name: string; description: string;
  recipient: 'bureau' | 'furnisher' | 'collector' | 'agency'; body: string;
}

export const KIND_LABEL: Record<LetterKind, string> = {
  bureau_dispute: 'Credit bureau dispute', creditor_dispute: 'Direct creditor dispute', validation_request: 'Debt validation request',
  collector_communication: 'Collector communication', follow_up: 'Follow-up on a dispute', investigation_response: 'Response to investigation result',
  personal_info_correction: 'Personal information correction', goodwill: 'Goodwill request', specialty_dispute: 'Specialty agency dispute',
  method_of_verification: 'Request for the reinvestigation procedure',
};

export const MERGE_FIELDS = ['date', 'client_name', 'client_address', 'ssn_last4_text', 'recipient_name', 'recipient_address', 'item_label', 'creditor', 'account_text', 'bureau', 'reason', 'agency_identity_text', 'agency_item_text', 'fields_text', 'enclosures', 'round_text', 'prior_date', 'dispute_date', 'response_date', 'org_name'] as const;

const HEAD = `{{date}}

{{client_name}}
{{client_address}}
{{ssn_last4_text}}
{{recipient_name}}
{{recipient_address}}
`;
/** The same heading with the identification lines a specialty agency asks for (consumer ID, date of birth, SSN) under the sender's address. */
const SPECIALTY_HEAD = HEAD.replace('{{ssn_last4_text}}', '{{ssn_last4_text}}{{agency_identity_text}}');

/**
 * Specialty agency disputes: one template per kind of agency, in English and Spanish. Each one states only what a
 * person entered (the item as it appears on the disclosure, and their reason), refers to the consumer's right to
 * dispute under the Fair Credit Reporting Act in general terms, and asks for a reinvestigation and a written result.
 * It asks for nothing else: no outcome is requested or implied, and nothing is said about what happens otherwise.
 */
const SPECIALTY_FILE: Record<AgencyKind, { label: string; en: string; es: string }> = {
  credit_bureau: { label: 'credit file', en: 'my credit file', es: 'mi expediente de crédito' },
  bank_account: { label: 'bank account history', en: 'the checking and savings account information in my consumer file', es: 'la información sobre cuentas de cheques y de ahorros en mi expediente de consumidor' },
  public_records: { label: 'public records', en: 'the public record and background information in my consumer file', es: 'la información de registros públicos y antecedentes en mi expediente de consumidor' },
  telecom_utilities: { label: 'telecom and utilities', en: 'the telecommunications and utility account information in my consumer file', es: 'la información sobre cuentas de telefonía y servicios públicos en mi expediente de consumidor' },
  check_verification: { label: 'check verification', en: 'the check writing and payment information in my consumer file', es: 'la información sobre cheques y pagos en mi expediente de consumidor' },
  alternative_credit: { label: 'alternative credit', en: 'the loan and account information in my consumer file', es: 'la información sobre préstamos y cuentas en mi expediente de consumidor' },
};

export const specialtyTemplateKey = (kind: AgencyKind, lang: 'en' | 'es') => `specialty_${kind}_${lang}`;

function specialtyTemplate(kind: AgencyKind, lang: 'en' | 'es'): LetterTemplate {
  const f = SPECIALTY_FILE[kind];
  const body = lang === 'en' ? `${SPECIALTY_HEAD}
Re: Dispute of information in my file — {{item_label}}{{round_text}}

To whom it may concern:

I am writing to dispute an item in ${f.en}. The Fair Credit Reporting Act gives me the right to dispute information that I believe is inaccurate or incomplete.

The item, as it appears on my disclosure:
{{agency_item_text}}
What I believe is inaccurate, incomplete or unverifiable, and why:
{{reason}}

Please conduct a reasonable reinvestigation of this item, consider the information I have provided, and send me the results in writing, along with an updated copy of my file if it changes.

{{enclosures}}
Sincerely,

{{client_name}}` : `${SPECIALTY_HEAD}
Asunto: Disputa de información en mi expediente — {{item_label}}{{round_text}}

A quien corresponda:

Les escribo para disputar un dato en ${f.es}. La Ley de Informes de Crédito Justos (FCRA) me da el derecho de disputar la información que considero inexacta o incompleta.

El dato, tal como aparece en mi informe:
{{agency_item_text}}
Lo que considero inexacto, incompleto o imposible de verificar, y por qué:
{{reason}}

Les pido que realicen una reinvestigación razonable de este dato, que consideren la información que les proporciono y que me envíen los resultados por escrito, junto con una copia actualizada de mi expediente si este cambia.

{{enclosures}}
Atentamente,

{{client_name}}`;
  return {
    key: specialtyTemplateKey(kind, lang), kind: 'specialty_dispute', language: lang, recipient: 'agency',
    name: lang === 'en' ? `Specialty agency dispute — ${f.label}` : `Disputa con agencia especializada — ${f.label}`,
    description: lang === 'en' ? 'Asks a specialty consumer reporting agency to reinvestigate one item entered from the consumer’s disclosure.' : 'Pide a una agencia especializada que reinvestigue un dato tomado del informe del consumidor.',
    body,
  };
}

export const TEMPLATES: LetterTemplate[] = [
  {
    key: 'bureau_dispute_en', kind: 'bureau_dispute', language: 'en', recipient: 'bureau', name: 'Bureau dispute — reinvestigation request (FCRA § 611)',
    description: 'Asks a credit bureau to reinvestigate one item and report the results.',
    body: `${HEAD}
Re: Request for reinvestigation — {{item_label}}{{round_text}}

To whom it may concern:

I am writing under Section 611 of the Fair Credit Reporting Act (15 U.S.C. § 1681i) about information in my credit file.

Item: {{item_label}}
{{fields_text}}
Reason for my request:
{{reason}}

Please conduct a reasonable reinvestigation of this item, consider the information I have provided, and send me the results in writing, along with an updated copy of my credit report if my file changes. If the information is verified, please describe the method of verification used and give me the business name and address of the furnisher you contacted.

{{enclosures}}
Sincerely,

{{client_name}}`,
  },
  {
    key: 'bureau_dispute_es', kind: 'bureau_dispute', language: 'es', recipient: 'bureau', name: 'Disputa con la agencia — solicitud de reinvestigación (FCRA § 611)',
    description: 'Versión en español de la solicitud de reinvestigación.',
    body: `${HEAD}
Asunto: Solicitud de reinvestigación — {{item_label}}{{round_text}}

A quien corresponda:

Les escribo conforme a la Sección 611 de la Ley de Informes de Crédito Justos (FCRA, 15 U.S.C. § 1681i) sobre información en mi expediente de crédito.

Cuenta: {{item_label}}
{{fields_text}}
Motivo de mi solicitud:
{{reason}}

Les pido que realicen una reinvestigación razonable de esta información, que consideren los datos que les proporciono y que me envíen los resultados por escrito, junto con una copia actualizada de mi informe si mi expediente cambia. Si la información se verifica, les ruego describir el método de verificación empleado e indicarme el nombre y la dirección de la empresa consultada.

{{enclosures}}
Atentamente,

{{client_name}}`,
  },
  {
    key: 'creditor_dispute_en', kind: 'creditor_dispute', language: 'en', recipient: 'furnisher', name: 'Direct dispute to the creditor (FCRA § 623(a)(8))',
    description: 'Disputes information directly with the company that reports it.',
    body: `${HEAD}
Re: Direct dispute of information you report — {{item_label}}

To whom it may concern:

I am writing to dispute information that your company reports to consumer reporting agencies about the account below. Under Section 623(a)(8) of the Fair Credit Reporting Act (15 U.S.C. § 1681s-2(a)(8)), I ask that you investigate.

Account: {{item_label}}
{{fields_text}}
Reason for my request:
{{reason}}

Please review your records, correct or delete any information you cannot verify, notify each consumer reporting agency to which you furnished it of any change, and send me a written response.

{{enclosures}}
Sincerely,

{{client_name}}`,
  },
  {
    key: 'validation_request_en', kind: 'validation_request', language: 'en', recipient: 'collector', name: 'Debt validation request (FDCPA § 809(b))',
    description: 'For collection accounts only. Must be sent within 30 days of the collector’s first written notice to use the statutory process.',
    body: `${HEAD}
Re: Dispute and request for validation of debt — {{item_label}}

To whom it may concern:

I am writing in response to your communication regarding the debt referenced above. Under Section 809(b) of the Fair Debt Collection Practices Act (15 U.S.C. § 1692g(b)), I dispute this debt and request that you provide validation of it, including:

  1. The amount of the debt and how it was calculated;
  2. The name and address of the original creditor;
  3. A copy of documents showing that I am obligated on the debt and that you are authorised to collect it.

{{reason}}

Until you mail me verification of the debt, I ask that you cease collection of it, as the statute provides. Please also confirm that you will not report this account as undisputed to any consumer reporting agency while this request is pending.

{{enclosures}}
Sincerely,

{{client_name}}`,
  },
  {
    key: 'validation_request_es', kind: 'validation_request', language: 'es', recipient: 'collector', name: 'Solicitud de validación de deuda (FDCPA § 809(b))',
    description: 'Solo para cuentas en cobranza.',
    body: `${HEAD}
Asunto: Disputa y solicitud de validación de deuda — {{item_label}}

A quien corresponda:

Respondo a su comunicación sobre la deuda indicada. Conforme a la Sección 809(b) de la Ley de Prácticas Justas de Cobro de Deudas (15 U.S.C. § 1692g(b)), disputo esta deuda y solicito su validación, incluyendo: (1) el monto y cómo se calculó; (2) el nombre y la dirección del acreedor original; (3) copia de los documentos que demuestren que estoy obligado(a) y que ustedes están autorizados a cobrarla.

{{reason}}

Hasta que me envíen la verificación por correo, les pido suspender el cobro, como establece la ley.

{{enclosures}}
Atentamente,

{{client_name}}`,
  },
  {
    key: 'collector_communication_en', kind: 'collector_communication', language: 'en', recipient: 'collector', name: 'Request to stop communication (FDCPA § 805(c))',
    description: 'Ceasing communication does not make a debt go away; the collector may still sue or report it.',
    body: `${HEAD}
Re: Request to cease communication — {{item_label}}

To whom it may concern:

Under Section 805(c) of the Fair Debt Collection Practices Act (15 U.S.C. § 1692c(c)), I am notifying you in writing that I want you to stop communicating with me about the debt referenced above. You may contact me only as the statute allows — for example, to tell me that collection efforts are ending or that you intend to take a specific action.

{{reason}}

{{enclosures}}
Sincerely,

{{client_name}}`,
  },
  {
    key: 'follow_up_en', kind: 'follow_up', language: 'en', recipient: 'bureau', name: 'Follow-up on a pending dispute',
    description: 'Asks for the status of a dispute that has passed its response window.',
    body: `${HEAD}
Re: Status of my dispute dated {{prior_date}} — {{item_label}}

To whom it may concern:

On {{prior_date}} I sent a dispute about the item above. I have not yet received the results of your reinvestigation. Please send me a written status update and the results of your investigation.

{{reason}}

{{enclosures}}
Sincerely,

{{client_name}}`,
  },
  {
    key: 'follow_up_es', kind: 'follow_up', language: 'es', recipient: 'bureau', name: 'Seguimiento de una disputa pendiente',
    description: 'Solicita el estado de una disputa cuyo plazo ya venció.',
    body: `${HEAD}
Asunto: Estado de mi disputa del {{prior_date}} — {{item_label}}

A quien corresponda:

El {{prior_date}} envié una disputa sobre la cuenta indicada y aún no he recibido los resultados de su reinvestigación. Les ruego enviarme por escrito el estado y los resultados.

{{reason}}

{{enclosures}}
Atentamente,

{{client_name}}`,
  },
  {
    key: 'investigation_response_en', kind: 'investigation_response', language: 'en', recipient: 'bureau', name: 'Response to a "verified" result — request method of verification',
    description: 'Use after a result says the item was verified. Include any NEW information or documents.',
    body: `${HEAD}
Re: Your response to my dispute dated {{prior_date}} — {{item_label}}

To whom it may concern:

I received your response stating that the item above was verified. Under Section 611(a)(7) of the Fair Credit Reporting Act (15 U.S.C. § 1681i(a)(7)), please provide a description of the procedure used to determine the accuracy and completeness of the information, including the business name, address and telephone number of any furnisher you contacted.

{{reason}}

{{enclosures}}
Sincerely,

{{client_name}}`,
  },
  {
    key: 'personal_info_correction_en', kind: 'personal_info_correction', language: 'en', recipient: 'bureau', name: 'Personal information correction',
    description: 'Asks a bureau to correct or remove names, addresses or employers that are not the consumer’s.',
    body: `${HEAD}
Re: Request to correct personal information in my file

To whom it may concern:

Please review the personal information in my credit file and update it as follows. {{reason}}

Please send me a written confirmation and an updated copy of my report.

{{enclosures}}
Sincerely,

{{client_name}}`,
  },
  {
    key: 'goodwill_en', kind: 'goodwill', language: 'en', recipient: 'furnisher', name: 'Goodwill adjustment request',
    description: 'A courtesy request — not a dispute of accuracy. No legal right is asserted.',
    body: `${HEAD}
Re: Goodwill request — {{item_label}}

Dear {{recipient_name}}:

I am writing about the account above. {{reason}}

I would be grateful if you would consider a goodwill adjustment to how this account is reported. Thank you for your time and for considering my request.

Sincerely,

{{client_name}}`,
  },
];

/** Kept out of TEMPLATES so the template pickers stay short: a specialty dispute's letter picks the right one by itself. */
export const SPECIALTY_TEMPLATES: LetterTemplate[] = AGENCY_KINDS.flatMap((k) => [specialtyTemplate(k, 'en'), specialtyTemplate(k, 'es')]);

/**
 * Request for the description of the reinvestigation procedure ("method of verification"), 15 U.S.C. § 1681i(a)(6)(B)(iii)
 * and (a)(7). Offered from a dispute only after a result of "verified as reported" is recorded, so it is kept out of the
 * pickers. It asks for the description the statute names and nothing else: it is not a new dispute, it asks for no
 * change to the file, and it says nothing about what happens otherwise. The agency generally has 15 days from receipt.
 */
export const procedureTemplateKey = (lang: 'en' | 'es') => `method_of_verification_${lang}`;
export const PROCEDURE_TEMPLATES: LetterTemplate[] = [
  {
    key: procedureTemplateKey('en'), kind: 'method_of_verification', language: 'en', recipient: 'bureau', name: 'Request for the reinvestigation procedure — FCRA § 611(a)(7)',
    description: 'Asks the agency to describe the procedure it used to verify an item. A request for information only.',
    body: `${SPECIALTY_HEAD}
Re: Request for a description of your reinvestigation procedure — {{item_label}}

To whom it may concern:

On {{dispute_date}} I sent you a dispute about the item above. Your results, which I received on {{response_date}}, state that the information was verified.

Under Section 611(a)(7) of the Fair Credit Reporting Act (15 U.S.C. § 1681i(a)(7)), I request a description of the procedure used to determine the accuracy and completeness of the information, including the business name and address of any furnisher of information contacted in connection with it and, if reasonably available, the telephone number of that furnisher.

This letter is a request for that description. It is not a new dispute.

Sincerely,

{{client_name}}`,
  },
  {
    key: procedureTemplateKey('es'), kind: 'method_of_verification', language: 'es', recipient: 'bureau', name: 'Solicitud del procedimiento de reinvestigación — FCRA § 611(a)(7)',
    description: 'Pide a la agencia que describa el procedimiento con el que verificó un dato. Es solo una solicitud de información.',
    body: `${SPECIALTY_HEAD}
Asunto: Solicitud de descripción de su procedimiento de reinvestigación — {{item_label}}

A quien corresponda:

El {{dispute_date}} les envié una disputa sobre el dato indicado. Sus resultados, que recibí el {{response_date}}, indican que la información fue verificada.

Conforme a la Sección 611(a)(7) de la Ley de Informes de Crédito Justos (FCRA, 15 U.S.C. § 1681i(a)(7)), solicito una descripción del procedimiento utilizado para determinar la exactitud e integridad de la información, incluidos el nombre comercial y la dirección de cualquier proveedor de información contactado en relación con ella y, si está razonablemente disponible, el número de teléfono de ese proveedor.

Esta carta es una solicitud de esa descripción. No es una nueva disputa.

Atentamente,

{{client_name}}`,
  },
];
const ALL_TEMPLATES = [...TEMPLATES, ...SPECIALTY_TEMPLATES, ...PROCEDURE_TEMPLATES];

export const templateByKey = (key: string) => ALL_TEMPLATES.find((t) => t.key === key);
export const templatesFor = (kind: LetterKind, lang: 'en' | 'es') => ALL_TEMPLATES.find((t) => t.kind === kind && t.language === lang) ?? ALL_TEMPLATES.find((t) => t.kind === kind && t.language === 'en');

const WORKFLOW_TO_KIND: Record<string, LetterKind> = {
  standard: 'bureau_dispute', furnisher_direct: 'creditor_dispute', validation: 'validation_request', personal_info: 'personal_info_correction', goodwill: 'goodwill',
  specialty: 'specialty_dispute',
};
export const kindForWorkflow = (w: string): LetterKind => WORKFLOW_TO_KIND[w] ?? 'bureau_dispute';
