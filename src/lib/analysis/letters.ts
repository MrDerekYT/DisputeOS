import { CITATIONS } from "./citations";
import type { Finding } from "./analyzer";

export type Lang = "en" | "es";
export interface Sender { name: string; address: string }

/** Hard blocks: AI/template output must never contain these (CPN / new-identity advice, outcome promises). */
const FORBIDDEN = /\b(cpn|credit privacy number|new identity|nueva identidad|guarantee[ds]?|garantiz\w*|garantía)\b/i;

export function assertSafe(text: string): string {
  const m = text.match(FORBIDDEN);
  if (m) throw new Error(`Blocked term in letter output: "${m[0]}"`);
  return text;
}

const T = {
  en: {
    to: "Consumer Dispute Department",
    via: "VIA CERTIFIED MAIL, RETURN RECEIPT REQUESTED",
    re: (f: Finding) => `Re: Request for reinvestigation: ${f.creditor}, account ending ${f.account || "----"}`,
    intro: "I am writing about information in my credit file that I believe is inaccurate or cannot be verified.",
    facts: "What I found:",
    law: "The law:",
    ask: {
      fcra_611: "Please conduct a reasonable reinvestigation, notify the furnisher, and send me the results in writing. If the information cannot be verified, it must be corrected or deleted.",
      fcra_623: "Please investigate this item, correct anything inaccurate, and notify the credit reporting agencies of the correction.",
      fdcpa_809: "Please provide validation of this debt: the original creditor's name, the amount owed and how it was calculated, and proof that you are authorized to collect it. Please do not report this item as valid until validation is provided.",
      obsolete: "Based on the dates above, this item appears to be past the allowed reporting period. Please reinvestigate and remove it if the dates are confirmed.",
    },
    close: "Please also tell me the method used to verify this information. Enclosed: copy of ID and proof of address.",
    sign: "Sincerely,",
  },
  es: {
    to: "Departamento de Disputas del Consumidor",
    via: "POR CORREO CERTIFICADO, ACUSE DE RECIBO SOLICITADO",
    re: (f: Finding) => `Ref.: Solicitud de reinvestigación: ${f.creditor}, cuenta terminada en ${f.account || "----"}`,
    intro: "Le escribo sobre información en mi expediente de crédito que considero inexacta o que no puede verificarse.",
    facts: "Lo que encontré:",
    law: "La ley:",
    ask: {
      fcra_611: "Por favor realice una reinvestigación razonable, notifique al proveedor de la información y envíeme los resultados por escrito. Si la información no puede verificarse, debe corregirse o eliminarse.",
      fcra_623: "Por favor investigue este asunto, corrija cualquier inexactitud y notifique la corrección a las agencias de crédito.",
      fdcpa_809: "Por favor proporcione la validación de esta deuda: el nombre del acreedor original, el monto adeudado y cómo se calculó, y prueba de que está autorizado a cobrarla. No reporte esta cuenta como válida hasta entregar la validación.",
      obsolete: "Según las fechas indicadas, esta cuenta parece haber superado el período permitido de reporte. Por favor reinvestigue y elimínela si las fechas se confirman.",
    },
    close: "Indíqueme también el método utilizado para verificar esta información. Se adjunta: copia de identificación y comprobante de domicilio.",
    sign: "Atentamente,",
  },
} as const;

/** Builds a letter strictly from the finding's own evidence and the vetted citation table. */
export function writeLetter(f: Finding, from: Sender, lang: Lang = "en", now: Date = new Date()): string {
  const t = T[lang];
  const target = f.bureaus.length ? f.bureaus.map((b) => b[0]!.toUpperCase() + b.slice(1)).join(" / ") : "[Recipient]";
  const body = [
    from.name,
    from.address,
    "",
    now.toISOString().slice(0, 10),
    "",
    `${target} ${t.to}`,
    "[Verified address from registry]",
    "",
    t.via,
    "",
    t.re(f),
    "",
    t.intro,
    "",
    t.facts,
    ...f.evidence.map((e) => `  - ${e}`),
    "",
    t.law,
    ...f.citations.map((k) => `  - ${CITATIONS[k].cite} ${CITATIONS[k][lang]}`),
    "",
    t.ask[f.letter],
    "",
    t.close,
    "",
    t.sign,
    from.name,
  ].join("\n");
  return assertSafe(body);
}
