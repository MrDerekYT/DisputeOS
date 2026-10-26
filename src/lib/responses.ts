import type { ItemStatus } from "./demo";

export type Outcome = "deleted" | "verified" | "updated" | "noResponse";
export type NextStep = "celebrate" | "methodOfVerification" | "reviewUpdate" | "escalateNoResponse";

export interface BureauResponse {
  clientId: string;
  creditor: string;
  bureau: string;
  outcome: Outcome;
  daysSinceSent: number;
}

export interface Decision {
  status: ItemStatus;
  next: NextStep;
  // Anything needing a human stays unsent until the admin approves it.
  needsApproval: boolean;
}

// FCRA 611(a)(1): 30 days to investigate, extendable to 45 when the consumer sends more information.
// Escalate only after 45 so a letter never claims a missed deadline that hasn't passed.
export const INVESTIGATION_DAYS = 30;
export const EXTENDED_DAYS = 45;

export function decide(r: BureauResponse): Decision {
  switch (r.outcome) {
    case "deleted":
      return { status: "removed", next: "celebrate", needsApproval: false };
    case "verified":
      return { status: "investigating", next: "methodOfVerification", needsApproval: true };
    case "updated":
      return { status: "investigating", next: "reviewUpdate", needsApproval: true };
    case "noResponse":
      return r.daysSinceSent > EXTENDED_DAYS
        ? { status: "investigating", next: "escalateNoResponse", needsApproval: true }
        : { status: "sent", next: "celebrate", needsApproval: false };
  }
}

export interface Sender { name: string; address: string }

// Follow-up letters are drafts only; they are never mailed without a human approver.
export function followUpLetter(r: BureauResponse, from: Sender, lang: "en" | "es" = "en", now = new Date()): string | null {
  const d = decide(r);
  const date = now.toISOString().slice(0, 10);
  const head = `${from.name}\n${from.address}\n${date}\n\n${r.bureau}\n`;
  if (d.next === "methodOfVerification") {
    return lang === "es"
      ? `${head}\nAsunto: Solicitud de descripción del procedimiento de verificación — ${r.creditor}\n\nRecibí su respuesta indicando que "${r.creditor}" fue verificado. Conforme a la Sección 611(a)(7) de la FCRA (15 U.S.C. 1681i(a)(7)), solicito una descripción del procedimiento utilizado para verificar la información, incluidos el nombre, la dirección y el teléfono de quien proporcionó los datos.\n\nAtentamente,\n${from.name}\n`
      : `${head}\nRe: Request for description of reinvestigation procedure — ${r.creditor}\n\nI received your response stating that "${r.creditor}" was verified. Under Section 611(a)(7) of the FCRA (15 U.S.C. 1681i(a)(7)), I request a description of the procedure used to verify the information, including the business name, address and telephone number of the furnisher contacted.\n\nSincerely,\n${from.name}\n`;
  }
  if (d.next === "escalateNoResponse") {
    return lang === "es"
      ? `${head}\nAsunto: Falta de respuesta a mi disputa — ${r.creditor}\n\nEnvié una disputa sobre "${r.creditor}" hace ${r.daysSinceSent} días y no he recibido respuesta. La Sección 611(a)(1) de la FCRA (15 U.S.C. 1681i(a)(1)) exige completar la investigación en 30 días (45 si se amplía). Han pasado más de 45 días. Solicito el resultado por escrito o la eliminación de la información no verificada.\n\nAtentamente,\n${from.name}\n`
      : `${head}\nRe: No response to my dispute — ${r.creditor}\n\nI sent a dispute about "${r.creditor}" ${r.daysSinceSent} days ago and have not received a response. Section 611(a)(1) of the FCRA (15 U.S.C. 1681i(a)(1)) requires the investigation to be completed within 30 days (45 if extended). More than 45 days have passed. Please send the written results, or delete the information if it cannot be verified.\n\nSincerely,\n${from.name}\n`;
  }
  return null;
}

// Demo inbox until real bureau replies are stored.
export const DEMO_RESPONSES: BureauResponse[] = [
  { clientId: "jordan-rivera", creditor: "Midland Credit", bureau: "Experian", outcome: "deleted", daysSinceSent: 27 },
  { clientId: "jordan-rivera", creditor: "Capital One", bureau: "Equifax", outcome: "verified", daysSinceSent: 33 },
  { clientId: "devon-brooks", creditor: "Credit One", bureau: "Equifax", outcome: "noResponse", daysSinceSent: 46 },
  { clientId: "alicia-torres", creditor: "Ally Financial", bureau: "Equifax", outcome: "updated", daysSinceSent: 29 },
];
