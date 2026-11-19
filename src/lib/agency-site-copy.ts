/**
 * The fixed copy of an agency's hosted website, in English and Spanish. An agency cannot edit any of this: the steps
 * describe what the product really does, and the notices are the ones a US credit repair organization has to give.
 * It never describes an outcome. Every key exists in both languages (the Spanish table is typed against the English one).
 */
import type { Lang } from './portal-i18n';

const EN = {
  nav_services: 'What we do', nav_how: 'How it works', nav_about: 'About', nav_faq: 'Questions', nav_contact: 'Contact',
  signIn: 'Client sign in', cta: 'Get in touch', menu: 'Menu',
  how_title: 'How it works',
  how_1t: 'We review your reports', how_1: 'We go through your credit reports with you, entry by entry.',
  how_2t: 'We find what to dispute', how_2: 'Together we mark the items you believe are inaccurate, incomplete or not yours.',
  how_3t: 'You approve every letter', how_3: 'We prepare the dispute letters. Nothing is sent until you have read and approved it.',
  how_4t: 'We track the responses', how_4: 'Each response and its dates are recorded, and you can follow every item in your client portal.',
  contact_title: 'Contact', phone: 'Phone', email: 'Email', hours: 'Hours', area: 'Service area',
  form_title: 'Ask us a question', form_sub: 'Tell us what you are working toward and how to reach you.',
  faq_title: 'Questions and answers',
  legal_title: 'Before you decide',
  legal_1: 'No result is guaranteed. The credit bureaus and the companies that report to them decide the outcome of every dispute.',
  legal_2: 'You have the right to dispute inaccurate information in your credit reports yourself, directly with the credit bureaus, at no cost.',
  legal_3: 'If you sign a contract with {org}, you may cancel it without penalty or obligation before midnight of the third business day after you sign it.',
  poweredBy: 'Powered by',
  description: '{org}: help reviewing your credit reports and disputing information you believe is inaccurate.',
  backToSite: 'Back to the {org} website',
} as const;
export type SiteKey = keyof typeof EN;

const ES: Record<SiteKey, string> = {
  nav_services: 'Qué hacemos', nav_how: 'Cómo funciona', nav_about: 'Quiénes somos', nav_faq: 'Preguntas', nav_contact: 'Contacto',
  signIn: 'Acceso para clientes', cta: 'Contáctenos', menu: 'Menú',
  how_title: 'Cómo funciona',
  how_1t: 'Revisamos sus informes', how_1: 'Repasamos con usted sus informes de crédito, cuenta por cuenta.',
  how_2t: 'Encontramos qué disputar', how_2: 'Juntos marcamos las cuentas que usted considera inexactas, incompletas o que no son suyas.',
  how_3t: 'Usted aprueba cada carta', how_3: 'Preparamos las cartas de disputa. Nada se envía hasta que usted la haya leído y aprobado.',
  how_4t: 'Damos seguimiento a las respuestas', how_4: 'Cada respuesta y sus fechas quedan registradas, y usted puede seguir cada cuenta en su portal de cliente.',
  contact_title: 'Contacto', phone: 'Teléfono', email: 'Correo electrónico', hours: 'Horario', area: 'Zona de servicio',
  form_title: 'Háganos una pregunta', form_sub: 'Cuéntenos cuál es su meta y cómo comunicarnos con usted.',
  faq_title: 'Preguntas y respuestas',
  legal_title: 'Antes de decidir',
  legal_1: 'Ningún resultado está garantizado. Las agencias de crédito y las empresas que les reportan deciden el resultado de cada disputa.',
  legal_2: 'Usted tiene derecho a disputar por su cuenta la información inexacta de sus informes de crédito, directamente con las agencias de crédito, sin costo.',
  legal_3: 'Si firma un contrato con {org}, puede cancelarlo sin penalidad ni obligación antes de la medianoche del tercer día hábil después de firmarlo.',
  poweredBy: 'Con tecnología de',
  description: '{org}: ayuda para revisar sus informes de crédito y disputar la información que usted considera inexacta.',
  backToSite: 'Volver al sitio de {org}',
};

export const siteCopy = (lang: Lang) => (k: SiteKey): string => (lang === 'es' ? ES[k] : EN[k]);
export const SITE_COPY = { en: EN, es: ES } as const;
