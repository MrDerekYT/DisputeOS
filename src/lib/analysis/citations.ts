export type CitationKey = "fcra_611" | "fcra_605" | "fcra_607b" | "fcra_609" | "fcra_623" | "fdcpa_809";

/** Vetted citations. Letters may only cite from this table; nothing is generated freehand. */
export const CITATIONS: Record<CitationKey, { cite: string; en: string; es: string }> = {
  fcra_611: {
    cite: "15 U.S.C. § 1681i",
    en: "requires a consumer reporting agency to conduct a reasonable reinvestigation of disputed information, generally within 30 days.",
    es: "exige que la agencia de informes de consumidores realice una reinvestigación razonable de la información disputada, generalmente dentro de 30 días.",
  },
  fcra_605: {
    cite: "15 U.S.C. § 1681c",
    en: "limits how long most adverse information may be reported (generally seven years, running from 180 days after the delinquency began for collections and charge-offs).",
    es: "limita el tiempo que se puede reportar la mayoría de la información adversa (generalmente siete años, contados desde 180 días después del inicio de la morosidad en cobranzas y cancelaciones).",
  },
  fcra_607b: {
    cite: "15 U.S.C. § 1681e(b)",
    en: "requires reasonable procedures to assure maximum possible accuracy of the information reported.",
    es: "exige procedimientos razonables para asegurar la máxima exactitud posible de la información reportada.",
  },
  fcra_609: {
    cite: "15 U.S.C. § 1681g",
    en: "gives consumers the right to disclosure of the information in their file.",
    es: "otorga a los consumidores el derecho a conocer la información de su expediente.",
  },
  fcra_623: {
    cite: "15 U.S.C. § 1681s-2(b)",
    en: "requires furnishers to investigate disputes forwarded by a consumer reporting agency and correct inaccurate information.",
    es: "exige que los proveedores de información investiguen las disputas enviadas por la agencia y corrijan la información inexacta.",
  },
  fdcpa_809: {
    cite: "15 U.S.C. § 1692g",
    en: "gives consumers the right to request validation of a debt from a debt collector.",
    es: "otorga a los consumidores el derecho a solicitar la validación de una deuda a un cobrador.",
  },
};
