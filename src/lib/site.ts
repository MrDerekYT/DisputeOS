export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");

export const SEO = {
  en: {
    title: "DisputeOS — Credit repair software with automated dispute letters",
    description:
      "Import credit reports, find disputable errors, send compliant dispute letters and track bureau responses automatically. Bilingual English and Spanish client portal.",
  },
  es: {
    title: "DisputeOS — Software de reparación de crédito con cartas automáticas",
    description:
      "Importe reportes de crédito, detecte errores disputables, envíe cartas conformes y dé seguimiento automático a las respuestas de los burós. Portal bilingüe.",
  },
} as const;
