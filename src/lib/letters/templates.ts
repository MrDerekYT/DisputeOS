/**
 * Letter templates. They state the sender's request and cite the statute that gives the right to make it — they do
 * NOT threaten, promise results, or characterise any item as inaccurate unless the sender wrote that in the reason.
 * Not legal advice; templates are starting points that a person reviews and edits. Have counsel review before use.
 */
export type LetterKind = 'bureau_dispute' | 'creditor_dispute' | 'validation_request' | 'collector_communication' | 'follow_up' | 'investigation_response' | 'personal_info_correction' | 'goodwill';

export interface LetterTemplate {
  key: string; kind: LetterKind; language: 'en' | 'es'; name: string; description: string;
  recipient: 'bureau' | 'furnisher' | 'collector'; body: string;
}

export const KIND_LABEL: Record<LetterKind, string> = {
  bureau_dispute: 'Credit bureau dispute', creditor_dispute: 'Direct creditor dispute', validation_request: 'Debt validation request',
  collector_communication: 'Collector communication', follow_up: 'Follow-up on a dispute', investigation_response: 'Response to investigation result',
  personal_info_correction: 'Personal information correction', goodwill: 'Goodwill request',
};

export const MERGE_FIELDS = ['date', 'client_name', 'client_address', 'ssn_last4_text', 'recipient_name', 'recipient_address', 'item_label', 'creditor', 'account_text', 'bureau', 'reason', 'fields_text', 'enclosures', 'round_text', 'prior_date', 'org_name'] as const;

const HEAD = `{{date}}

{{client_name}}
{{client_address}}
{{ssn_last4_text}}
{{recipient_name}}
{{recipient_address}}
`;

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

export const templateByKey = (key: string) => TEMPLATES.find((t) => t.key === key);
export const templatesFor = (kind: LetterKind, lang: 'en' | 'es') => TEMPLATES.find((t) => t.kind === kind && t.language === lang) ?? TEMPLATES.find((t) => t.kind === kind && t.language === 'en');

const WORKFLOW_TO_KIND: Record<string, LetterKind> = {
  standard: 'bureau_dispute', furnisher_direct: 'creditor_dispute', validation: 'validation_request', personal_info: 'personal_info_correction', goodwill: 'goodwill',
};
export const kindForWorkflow = (w: string): LetterKind => WORKFLOW_TO_KIND[w] ?? 'bureau_dispute';
