/**
 * The credit guide's knowledge base: short, plain-language, general education in English and Spanish.
 *
 * Rules for every entry (enforced by tests/unit/guide.test.ts):
 *  - it passes the claims guard (no promises, no predicted scores, no "we will remove");
 *  - where facts vary it says "generally", "typically" or "usually";
 *  - it never suggests disputing information that is accurate;
 *  - it is education, not legal or financial advice.
 * The guide answers ONLY from these entries. Anything else falls back to "ask your specialist".
 */
import type { Lang } from '../portal-i18n';

export type GuideAudience = 'portal' | 'app';

export interface GuideLink {
  label: Record<Lang, string>;
  /** One address for everyone (external sites), or a different screen for the portal and the staff app. */
  href: string | Partial<Record<GuideAudience, string>>;
}

export interface GuideEntry {
  id: string;
  /** Only shown to this audience (how-this-screen-works entries). Absent = everyone. */
  audience?: GuideAudience;
  question: Record<Lang, string>;
  /** Lower-case words and phrases, without accents, in both languages. A phrase counts more than a single word. */
  keywords: string[];
  answer: Record<Lang, string>;
  links?: GuideLink[];
}

const ACR: GuideLink = { label: { en: 'AnnualCreditReport.com (official free reports)', es: 'AnnualCreditReport.com (informes gratuitos oficiales)' }, href: 'https://www.annualcreditreport.com' };
const IDT: GuideLink = { label: { en: 'IdentityTheft.gov (FTC recovery steps)', es: 'RobodeIdentidad.gov (pasos de la FTC)' }, href: 'https://www.identitytheft.gov' };
const CFPB: GuideLink = { label: { en: 'Consumer Financial Protection Bureau: credit reports', es: 'Oficina para la Protección Financiera del Consumidor: informes de crédito' }, href: 'https://www.consumerfinance.gov/consumer-tools/credit-reports-and-scores/' };
const DOCS: GuideLink = { label: { en: 'Documents', es: 'Documentos' }, href: { portal: '/portal/documents', app: '/app/clients' } };
const ITEMS: GuideLink = { label: { en: 'Disputed items', es: 'Cuentas en disputa' }, href: { portal: '/portal/disputes', app: '/app/disputes' } };
const LETTERS: GuideLink = { label: { en: 'Letters', es: 'Cartas' }, href: { portal: '/portal/letters', app: '/app/letters' } };
const MESSAGES: GuideLink = { label: { en: 'Message your specialist', es: 'Escribir a su especialista' }, href: { portal: '/portal/messages' } };
const AGREEMENTS: GuideLink = { label: { en: 'Agreements and your rights', es: 'Acuerdos y sus derechos' }, href: { portal: '/portal/profile#agreements' } };
const PROTECT: GuideLink = { label: { en: 'Protect your file (official links)', es: 'Proteja su expediente (enlaces oficiales)' }, href: { portal: '/portal/protect' } };
const CLIENTS: GuideLink = { label: { en: 'Clients', es: 'Clientes' }, href: { app: '/app/clients' } };

export const GUIDE_ENTRIES: GuideEntry[] = [
  {
    id: 'how-it-works',
    question: { en: 'How does fixing my credit actually work?', es: '¿Cómo funciona realmente arreglar mi crédito?' },
    keywords: ['fix my credit', 'fix credit', 'repair my credit', 'improve my credit', 'better credit', 'bad credit', 'how does credit repair work', 'how does this work', 'where do i start', 'what should i do', 'do first', 'dont know', 'new to this', 'explain', 'arreglar mi credito', 'arreglo mi credito', 'reparar mi credito', 'mejorar mi credito', 'mal credito', 'por donde empiezo', 'que debo hacer', 'no se', 'explicar'],
    answer: {
      en: 'It generally comes down to four things. First, get your free reports from all three bureaus and read them. Second, dispute only what you believe is inaccurate, incomplete or unverifiable — the bureau then investigates and decides. Third, look after what is accurate: pay current accounts on time and keep card balances low relative to their limits. Fourth, give it time, because older negative items typically matter less and eventually leave the report. No one can promise a particular result, and none of this needs a company — you can do each step yourself at no cost.',
      es: 'Generalmente se reduce a cuatro cosas. Primero, obtenga sus informes gratuitos de las tres agencias y léalos. Segundo, dispute solo lo que crea inexacto, incompleto o imposible de verificar: la agencia investiga y decide. Tercero, cuide lo que sí es exacto: pague a tiempo sus cuentas actuales y mantenga bajos los saldos de sus tarjetas en relación con sus límites. Cuarto, dé tiempo, porque los datos negativos antiguos normalmente pesan menos y con el tiempo salen del informe. Nadie puede prometer un resultado en particular, y nada de esto requiere una empresa: puede hacer cada paso por su cuenta sin costo.',
    },
    links: [ACR, ITEMS, CFPB],
  },
  {
    id: 'credit-report',
    question: { en: 'What is a credit report?', es: '¿Qué es un informe de crédito?' },
    keywords: ['credit report', 'what is a report', 'credit file', 'bureau', 'bureaus', 'experian', 'equifax', 'transunion', 'informe de credito', 'reporte de credito', 'buro', 'agencia', 'agencias'],
    answer: {
      en: 'A credit report is a record of how you have used credit: your accounts, balances, payment history, collections, public records and who has asked to see your file. Three national bureaus keep one each — Experian, Equifax and TransUnion — and they do not always match, because lenders do not all report to every bureau.',
      es: 'Un informe de crédito es un registro de cómo ha usado el crédito: sus cuentas, saldos, historial de pagos, cobranzas, registros públicos y quién ha pedido ver su expediente. Tres agencias nacionales llevan uno cada una — Experian, Equifax y TransUnion — y no siempre coinciden, porque no todos los acreedores reportan a las tres.',
    },
    links: [ACR, CFPB],
  },
  {
    id: 'free-reports',
    question: { en: 'How do I get my free credit reports?', es: '¿Cómo obtengo mis informes de crédito gratis?' },
    keywords: ['free report', 'free reports', 'free credit report', 'get my report', 'get my reports', 'annualcreditreport', 'annual credit report', 'pull my credit', 'download report', 'informe gratis', 'informes gratis', 'reporte gratis', 'obtener mi informe', 'conseguir mi informe', 'free', 'gratis', 'gratuito', 'gratuitos', 'credito gratis', 'informe de credito gratis', 'informes de credito gratis'],
    answer: {
      en: 'You can request your reports from all three bureaus at AnnualCreditReport.com, the official site. They are free, generally available once a week, and checking your own report does not affect your credit. Save each report as a PDF so it can be read here.',
      es: 'Puede pedir sus informes de las tres agencias en AnnualCreditReport.com, el sitio oficial. Son gratuitos, generalmente están disponibles una vez por semana, y revisar su propio informe no afecta su crédito. Guarde cada informe como PDF para que pueda leerse aquí.',
    },
    links: [ACR, DOCS],
  },
  {
    id: 'read-report',
    question: { en: 'How do I read my credit report?', es: '¿Cómo leo mi informe de crédito?' },
    keywords: ['read my credit report', 'how do i read', 'read my report', 'read a report', 'read report', 'understand my report', 'understand report', 'sections', 'what does my report mean', 'leer mi informe', 'leer informe', 'entender mi informe', 'secciones'],
    answer: {
      en: 'Most reports have four parts: personal information (names, addresses, employers), accounts (each with its balance, limit, status and payment history), public records and collections, and inquiries (who looked at your file). Go through each account and check that it is yours and that the dates, balances and status look right. Note anything you do not recognise or believe is wrong.',
      es: 'La mayoría de los informes tienen cuatro partes: información personal (nombres, direcciones, empleadores), cuentas (cada una con su saldo, límite, estado e historial de pagos), registros públicos y cobranzas, y consultas (quién revisó su expediente). Revise cada cuenta y confirme que es suya y que las fechas, saldos y estado parecen correctos. Anote todo lo que no reconozca o crea que está mal.',
    },
    links: [CFPB],
  },
  {
    id: 'credit-score',
    question: { en: 'What goes into a credit score?', es: '¿Qué influye en un puntaje de crédito?' },
    keywords: ['credit score', 'score', 'scores', 'fico', 'vantagescore', 'what affects my score', 'puntaje', 'puntuacion', 'puntaje de credito', 'calificacion'],
    answer: {
      en: 'A credit score is a number calculated from the information in a credit report. Scoring models generally look at payment history, how much of your available credit you use, how long you have had credit, the mix of account types and recent applications. There are many models and lenders choose their own, so scores differ from place to place. No one can honestly tell you what your score will be after any particular action.',
      es: 'Un puntaje de crédito es un número calculado con la información de un informe de crédito. Los modelos generalmente consideran el historial de pagos, cuánto usa de su crédito disponible, la antigüedad de su crédito, los tipos de cuentas y las solicitudes recientes. Existen muchos modelos y cada prestamista elige el suyo, por lo que los puntajes varían. Nadie puede decirle con honestidad cuál será su puntaje después de una acción en particular.',
    },
    links: [CFPB],
  },
  {
    id: 'dispute',
    question: { en: 'What is a dispute?', es: '¿Qué es una disputa?' },
    keywords: ['what is a dispute', 'dispute', 'disputes', 'disputing', 'challenge', 'dispute letter', 'que es una disputa', 'disputa', 'disputas', 'disputar', 'reclamo'],
    answer: {
      en: 'A dispute is a written request asking a credit bureau, or the company that reported an account, to investigate information you believe is inaccurate, incomplete or cannot be verified. You explain what looks wrong and include any supporting documents. They investigate and then correct, remove or keep the information depending on what they find.',
      es: 'Una disputa es una solicitud por escrito para que una agencia de crédito, o la empresa que reportó una cuenta, investigue información que usted cree inexacta, incompleta o que no puede verificarse. Usted explica qué parece estar mal e incluye los documentos de respaldo. Ellos investigan y luego corrigen, eliminan o mantienen la información según lo que encuentren.',
    },
    links: [ITEMS],
  },
  {
    id: 'when-to-dispute',
    question: { en: 'When does it make sense to dispute something?', es: '¿Cuándo tiene sentido disputar algo?' },
    keywords: ['when to dispute', 'should i dispute', 'what can i dispute', 'can i dispute', 'dispute everything', 'worth disputing', 'inaccurate', 'incomplete', 'unverifiable', 'error', 'errors', 'mistake', 'mistakes', 'wrong', 'not mine', 'cuando disputar', 'debo disputar', 'que puedo disputar', 'inexacto', 'inexacta', 'incompleto', 'equivocado', 'no es mio', 'no es mia'],
    answer: {
      en: 'Dispute only information you believe is inaccurate, incomplete or unverifiable — for example an account that is not yours, a wrong balance or date, a payment marked late that was on time, or the same debt listed twice. If an item is reported accurately, there is nothing to dispute, and disputing it is not appropriate. Evidence such as statements or letters generally makes a dispute clearer.',
      es: 'Dispute solo la información que crea inexacta, incompleta o imposible de verificar — por ejemplo una cuenta que no es suya, un saldo o fecha incorrectos, un pago marcado como atrasado que fue puntual, o la misma deuda listada dos veces. Si un dato está reportado con exactitud, no hay nada que disputar y no corresponde hacerlo. Los documentos de respaldo, como estados de cuenta o cartas, generalmente hacen más clara una disputa.',
    },
    links: [ITEMS],
  },
  {
    id: 'accurate-negative',
    question: { en: 'Can accurate negative information be taken off my report?', es: '¿Se puede quitar de mi informe información negativa que es correcta?' },
    keywords: ['accurate', 'true', 'legitimate', 'really mine', 'my fault', 'remove negative', 'delete negative', 'remove everything', 'clean my credit', 'wipe', 'erase', 'negative items', 'correcto', 'correcta', 'verdadero', 'quitar negativo', 'borrar negativo', 'limpiar mi credito', 'cuentas negativas'],
    answer: {
      en: 'Generally, no. Information that is accurate, current and verifiable typically stays on a report until its reporting period ends, and no one can lawfully promise otherwise. What you can do is check that every detail is reported correctly, keep current accounts paid on time, and let time pass — older items generally matter less than recent ones.',
      es: 'Generalmente, no. La información que es exacta, actual y verificable normalmente permanece en el informe hasta que termina su periodo de reporte, y nadie puede prometer legalmente otra cosa. Lo que sí puede hacer es confirmar que cada detalle esté bien reportado, mantener al día sus cuentas actuales y dejar pasar el tiempo: los datos antiguos generalmente pesan menos que los recientes.',
    },
    links: [CFPB],
  },
  {
    id: 'dispute-timeline',
    question: { en: 'How long does a dispute investigation take?', es: '¿Cuánto tarda la investigación de una disputa?' },
    keywords: ['how long', 'investigation', 'investigate', '30 days', '45 days', 'timeline', 'deadline', 'waiting', 'when will i hear', 'response date', 'cuanto tarda', 'cuanto tiempo', 'investigacion', '30 dias', '45 dias', 'plazo', 'esperando'],
    answer: {
      en: 'A credit bureau generally has 30 days from receiving a dispute to investigate it. That can extend to 45 days in some cases — for example if you send more information during the investigation, or the dispute follows a free annual report. Mailing time comes on top, so replies typically arrive a little after the investigation ends.',
      es: 'Una agencia de crédito generalmente tiene 30 días desde que recibe una disputa para investigarla. Ese plazo puede extenderse a 45 días en algunos casos — por ejemplo si usted envía más información durante la investigación, o si la disputa sigue a un informe anual gratuito. A eso se suma el tiempo del correo, por lo que las respuestas normalmente llegan un poco después de terminar la investigación.',
    },
    links: [ITEMS],
  },
  {
    id: 'dispute-outcomes',
    question: { en: 'What are the possible results of a dispute?', es: '¿Cuáles son los resultados posibles de una disputa?' },
    keywords: ['outcome', 'outcomes', 'result', 'results', 'verified', 'deleted', 'updated', 'corrected', 'what can happen', 'possible results', 'resultado', 'resultados', 'verificado', 'verificada', 'eliminado', 'actualizado', 'corregido', 'que puede pasar'],
    answer: {
      en: 'There are generally three results. The item may be removed, if the company cannot verify it or agrees it is wrong. It may be updated, if part of it is corrected. Or it may be verified, meaning the company confirmed it as reported and it stays. Sometimes there is no clear answer and a follow-up is needed. The bureaus and the reporting companies decide — not you and not a credit repair company — so results vary.',
      es: 'Generalmente hay tres resultados. El dato puede eliminarse, si la empresa no puede verificarlo o reconoce que está mal. Puede actualizarse, si se corrige una parte. O puede verificarse, es decir, la empresa lo confirmó tal como estaba y permanece. A veces no hay una respuesta clara y hace falta un seguimiento. Deciden las agencias y las empresas que reportan — no usted ni una empresa de reparación de crédito — así que los resultados varían.',
    },
    links: [ITEMS],
  },
  {
    id: 'after-reply',
    question: { en: 'What happens after a reply arrives?', es: '¿Qué pasa después de que llega una respuesta?' },
    keywords: ['after a reply', 'reply', 'response', 'got a letter', 'received a letter', 'bureau responded', 'next round', 'second round', 'follow up', 'still there', 'respuesta', 'recibi una carta', 'llego una carta', 'siguiente ronda', 'seguimiento', 'sigue ahi'],
    answer: {
      en: 'Keep the reply — it is your record of what was decided. If the item was removed or corrected, check your next report to confirm the change. If it was verified and you still believe it is wrong, you can typically follow up with new information or documents, contact the company that reported it directly, or add a short statement to your file. Sending the same dispute again with nothing new is generally not useful and may be treated as frivolous.',
      es: 'Conserve la respuesta: es su constancia de lo que se decidió. Si el dato fue eliminado o corregido, revise su próximo informe para confirmar el cambio. Si fue verificado y usted sigue creyendo que está mal, normalmente puede dar seguimiento con información o documentos nuevos, contactar directamente a la empresa que lo reportó, o añadir una breve declaración a su expediente. Enviar la misma disputa otra vez sin nada nuevo generalmente no sirve y puede considerarse frívola.',
    },
    links: [DOCS, ITEMS],
  },
  {
    id: 'collections',
    question: { en: 'What is a collection account?', es: '¿Qué es una cuenta en cobranza?' },
    keywords: ['collection', 'collections', 'collector', 'collection agency', 'debt collector', 'debt buyer', 'pay a collection', 'cobranza', 'cobranzas', 'cobrador', 'agencia de cobranza', 'coleccion', 'colecciones'],
    answer: {
      en: 'A collection is a debt that the original creditor has passed or sold to a collection company after it went unpaid. It generally appears as its own entry on your report. If you recognise the debt and it is reported accurately, there is nothing to dispute; paying or settling it updates the balance, though the entry itself typically remains for its reporting period. If you do not recognise it, you can ask the collector to validate it.',
      es: 'Una cobranza es una deuda que el acreedor original pasó o vendió a una empresa de cobranza después de quedar impaga. Generalmente aparece como una entrada aparte en su informe. Si reconoce la deuda y está reportada con exactitud, no hay nada que disputar; pagarla o liquidarla actualiza el saldo, aunque la entrada normalmente permanece durante su periodo de reporte. Si no la reconoce, puede pedirle al cobrador que la valide.',
    },
    links: [CFPB],
  },
  {
    id: 'debt-validation',
    question: { en: 'What is debt validation?', es: '¿Qué es la validación de deuda?' },
    keywords: ['debt validation', 'validation', 'validate', 'validation letter', 'prove the debt', 'proof of debt', 'do not recognize', 'dont recognize', 'validacion', 'validar', 'validacion de deuda', 'probar la deuda', 'no reconozco'],
    answer: {
      en: 'Debt validation is your right to ask a debt collector for details about a debt: who the original creditor is and how much is owed. A collector must generally send a validation notice within 5 days of first contacting you. The validation period generally ends 30 days after you receive that notice, and the notice itself states the date. If you dispute the debt or ask for the original creditor in writing within that period, the collector generally has to pause collection until it responds. Writing later is still possible, but the pause is generally not required, and not writing is not an admission that you owe the debt. This is a separate deadline from a dispute with a credit bureau, and it applies to collectors, not usually to the original creditor.',
      es: 'La validación de deuda es su derecho a pedirle a un cobrador los detalles de una deuda: quién es el acreedor original y cuánto se debe. El cobrador generalmente debe enviar un aviso de validación dentro de los 5 días posteriores a su primer contacto. El período de validación generalmente termina 30 días después de que usted recibe ese aviso, y el propio aviso indica la fecha. Si usted disputa la deuda o pide el acreedor original por escrito dentro de ese período, el cobrador generalmente debe pausar la cobranza hasta responder. Todavía puede escribir después, pero la pausa generalmente no es obligatoria, y no escribir no significa reconocer la deuda. Es un plazo distinto al de una disputa con una agencia de crédito, y se aplica a cobradores, por lo general no al acreedor original.',
    },
    links: [CFPB, LETTERS],
  },
  {
    id: 'medical-collections',
    question: { en: 'Do medical collections appear on credit reports?', es: '¿Aparecen las cobranzas médicas en los informes de crédito?' },
    keywords: ['medical', 'medical debt', 'medical collection', 'medical collections', 'medical bill', 'medical bills', 'hospital bill', 'doctor bill', 'under 500', 'hospital', 'deuda medica', 'deudas medicas', 'cobranza medica', 'cobranzas medicas', 'factura medica', 'cuenta medica', 'medica', 'medicas'],
    answer: {
      en: 'Experian, Equifax and TransUnion have said that, under their own policy, they generally do not report medical collections that have been paid, that started with a balance under $500, or that are less than one year old (their joint statements of March 2022 and April 2023). This is bureau policy, not a law: a federal rule that would have kept medical debt off credit reports was vacated by a court in July 2025 and is not in effect, and state laws differ. If a medical collection on your report looks like one of those three cases, compare the dates and amounts with your own records; if they hold, you can ask the bureau to review it. A medical collection that is unpaid, $500 or more and over a year old is generally reported like other collections.',
      es: 'Experian, Equifax y TransUnion han dicho que, por su propia política, generalmente no reportan las cobranzas médicas que ya fueron pagadas, que comenzaron con un saldo menor de $500 o que tienen menos de un año (sus comunicados conjuntos de marzo de 2022 y abril de 2023). Es una política de las agencias, no una ley: una norma federal que habría excluido la deuda médica de los informes de crédito fue anulada por un tribunal en julio de 2025 y no está vigente, y las leyes estatales varían. Si una cobranza médica en su informe parece estar en uno de esos tres casos, compare las fechas y los montos con sus propios registros; si coinciden, puede pedirle a la agencia que la revise. Una cobranza médica sin pagar, de $500 o más y con más de un año generalmente se reporta como las demás cobranzas.',
    },
    links: [CFPB, ITEMS],
  },
  {
    id: 'charge-off',
    question: { en: 'What is a charge-off?', es: '¿Qué es una cuenta castigada (charge-off)?' },
    keywords: ['charge off', 'charge-off', 'chargeoff', 'charged off', 'written off', 'cuenta castigada', 'castigada', 'cancelada por perdida', 'deuda castigada'],
    answer: {
      en: 'A charge-off means a creditor has written an account off as a loss, typically after about 180 days without payment. The debt generally still exists and may be collected or sold to a collector. Check that the balance, dates and status are reported correctly, and that the same debt is not reported with a balance by both the original creditor and a collector.',
      es: 'Una cuenta castigada (charge-off) significa que el acreedor la registró como pérdida, normalmente tras unos 180 días sin pago. La deuda generalmente sigue existiendo y puede cobrarse o venderse a un cobrador. Revise que el saldo, las fechas y el estado estén bien reportados, y que la misma deuda no aparezca con saldo tanto con el acreedor original como con un cobrador.',
    },
  },
  {
    id: 'late-payments',
    question: { en: 'How do late payments work?', es: '¿Cómo funcionan los pagos atrasados?' },
    keywords: ['late payment', 'late payments', 'late', 'missed payment', 'missed a payment', 'past due', 'delinquent', 'delinquency', 'pago atrasado', 'pagos atrasados', 'atraso', 'atrasado', 'pago tardio', 'moroso'],
    answer: {
      en: 'Creditors generally report a payment as late only once it is 30 days or more past due, then again at 60, 90 and so on. A late payment typically stays on a report for up to 7 years. If a payment is marked late but you paid on time, that is the kind of error a dispute is for — a bank statement showing the payment date helps. If it was late, the most useful thing is generally to keep the account current from here on.',
      es: 'Los acreedores generalmente reportan un pago como atrasado solo cuando lleva 30 días o más de vencido, y de nuevo a los 60, 90 y así sucesivamente. Un pago atrasado normalmente permanece en el informe hasta 7 años. Si un pago aparece como atrasado pero usted pagó a tiempo, ese es el tipo de error para el que sirve una disputa: un estado de cuenta con la fecha del pago ayuda. Si sí se atrasó, lo más útil generalmente es mantener la cuenta al día de aquí en adelante.',
    },
  },
  {
    id: 'hard-inquiries',
    question: { en: 'What is a hard inquiry?', es: '¿Qué es una consulta dura (hard inquiry)?' },
    keywords: ['inquiry', 'inquiries', 'hard inquiry', 'hard pull', 'soft inquiry', 'soft pull', 'credit check', 'applied for', 'consulta', 'consultas', 'consulta dura', 'consulta suave', 'verificacion de credito'],
    answer: {
      en: 'A hard inquiry is recorded when a lender checks your report because you applied for credit. It generally stays on the report for 2 years. Soft inquiries — checking your own report, or pre-approved offers — are visible only to you and do not count against you. An inquiry you authorised is accurate and is not something to dispute; one you never authorised can be a sign of identity theft and is worth looking into.',
      es: 'Una consulta dura se registra cuando un prestamista revisa su informe porque usted solicitó crédito. Generalmente permanece en el informe 2 años. Las consultas suaves — revisar su propio informe u ofertas preaprobadas — solo las ve usted y no cuentan en su contra. Una consulta que usted autorizó es correcta y no es algo para disputar; una que nunca autorizó puede ser señal de robo de identidad y conviene revisarla.',
    },
  },
  {
    id: 'utilization',
    question: { en: 'What is credit utilisation and the 30% rule of thumb?', es: '¿Qué es la utilización de crédito y la regla general del 30%?' },
    keywords: ['utilization', 'utilisation', 'usage', 'card usage', '30%', '30 percent', 'credit limit', 'limit', 'maxed out', 'card balance', 'balances', 'pay down', 'utilizacion', 'uso de credito', 'uso de tarjeta', '30 por ciento', 'limite de credito', 'saldo de tarjeta'],
    answer: {
      en: 'Utilisation is how much of your revolving credit (mostly credit cards) you are using: total balances divided by total limits. A common rule of thumb is to keep it under about 30%, and lower is generally viewed more favourably. It is a guideline, not a law or a threshold that changes a score by a set amount. It is typically based on the balance your card issuer reports, usually around the statement date.',
      es: 'La utilización es cuánto usa de su crédito rotativo (sobre todo tarjetas): el total de saldos dividido entre el total de límites. Una regla general común es mantenerla por debajo de aproximadamente el 30%, y cuanto más baja generalmente se ve mejor. Es una guía, no una ley ni un umbral que cambie un puntaje en una cantidad fija. Normalmente se basa en el saldo que reporta el emisor de su tarjeta, por lo general cerca de la fecha del estado de cuenta.',
    },
  },
  {
    id: 'how-long-items-stay',
    question: { en: 'How long do items stay on a credit report?', es: '¿Cuánto tiempo permanecen los datos en un informe de crédito?' },
    keywords: ['how long do items stay', 'stay on my report', 'stay on report', 'fall off', 'drop off', '7 years', 'seven years', '10 years', 'reporting period', 'old debt', 'too old', 'cuanto tiempo permanece', 'permanecen', '7 anos', 'siete anos', '10 anos', 'periodo de reporte', 'deuda vieja'],
    answer: {
      en: 'Most negative information — late payments, collections, charge-offs — generally stays for up to 7 years from the date of the first missed payment that led to it. Chapter 7 bankruptcies typically stay up to 10 years from filing. Hard inquiries generally stay 2 years. Accounts in good standing can stay much longer, which usually works in your favour. Paying an old debt does not restart the reporting period.',
      es: 'La mayor parte de la información negativa — pagos atrasados, cobranzas, cuentas castigadas — generalmente permanece hasta 7 años desde la fecha del primer pago incumplido que la originó. Las bancarrotas del Capítulo 7 normalmente permanecen hasta 10 años desde su presentación. Las consultas duras generalmente permanecen 2 años. Las cuentas en buen estado pueden permanecer mucho más, lo que por lo general le favorece. Pagar una deuda antigua no reinicia el periodo de reporte.',
    },
    links: [CFPB],
  },
  {
    id: 'bankruptcy',
    question: { en: 'How does bankruptcy show on a credit report?', es: '¿Cómo aparece una bancarrota en el informe de crédito?' },
    keywords: ['bankruptcy', 'bankrupt', 'chapter 7', 'chapter 13', 'discharged', 'discharge', 'bancarrota', 'quiebra', 'capitulo 7', 'capitulo 13'],
    answer: {
      en: 'A bankruptcy appears as a public record. The law generally allows it to be reported for up to 10 years from the filing date; Experian and TransUnion say they take a Chapter 13 bankruptcy off 7 years after the filing date, which is their own policy. Accounts that were discharged are generally expected to show a zero balance and a status that reflects the bankruptcy, so an account still showing a balance owed, or a new late payment after the filing, is worth checking against your bankruptcy papers. Some debts are generally not discharged, such as most student loans, and those are reported as usual. Whether bankruptcy is right for someone is a legal question for an attorney.',
      es: 'Una bancarrota aparece como registro público. La ley generalmente permite reportarla hasta 10 años desde la fecha de presentación; Experian y TransUnion dicen que retiran una bancarrota del Capítulo 13 a los 7 años de la presentación, lo cual es su propia política. Las cuentas descargadas generalmente deben mostrar saldo cero y un estado que refleje la bancarrota, así que conviene comparar con sus documentos de bancarrota una cuenta que siga mostrando saldo pendiente o un nuevo atraso posterior a la presentación. Algunas deudas generalmente no se descargan, como la mayoría de los préstamos estudiantiles, y se reportan de la forma habitual. Si la bancarrota le conviene a alguien es una pregunta legal para un abogado.',
    },
  },
  {
    id: 'identity-theft',
    question: { en: 'What should I do about identity theft?', es: '¿Qué hago si fui víctima de robo de identidad?' },
    keywords: ['identity theft', 'stolen identity', 'fraud', 'fraudulent', 'someone opened', 'opened in my name', 'not my account', 'identitytheft', 'ftc report', 'police report', 'robo de identidad', 'fraude', 'fraudulenta', 'abrieron a mi nombre', 'robaron mi identidad'],
    answer: {
      en: 'If accounts were opened or used without your permission: report it at IdentityTheft.gov, which creates an FTC identity theft report and a recovery plan; consider a fraud alert or a credit freeze; and contact the companies involved to close or secure the accounts. With an identity theft report, bureaus must generally block the fraudulent information within 4 business days of accepting your request. Only describe something as identity theft if it truly is.',
      es: 'Si se abrieron o usaron cuentas sin su permiso: repórtelo en RobodeIdentidad.gov (IdentityTheft.gov), que genera un informe de robo de identidad de la FTC y un plan de recuperación; considere una alerta de fraude o un congelamiento de crédito; y contacte a las empresas involucradas para cerrar o proteger las cuentas. Con un informe de robo de identidad, las agencias generalmente deben bloquear la información fraudulenta dentro de 4 días hábiles después de aceptar su solicitud. Describa algo como robo de identidad solo si realmente lo es.',
    },
    links: [IDT, DOCS],
  },
  {
    id: 'credit-freeze',
    question: { en: 'What is a credit freeze?', es: '¿Qué es un congelamiento de crédito?' },
    keywords: ['freeze', 'credit freeze', 'security freeze', 'frozen', 'unfreeze', 'thaw', 'lock my credit', 'congelamiento', 'congelar', 'congelar mi credito', 'descongelar', 'bloqueo de credito'],
    answer: {
      en: 'A security freeze, also called a credit freeze, restricts access to your credit file for new credit, which makes it harder for someone else to open accounts in your name. At Experian, Equifax and TransUnion it is free under federal law. You ask each bureau separately, and you ask yourself: we cannot place it for you. It stays until you lift it, and you generally need to lift it before applying for new credit. A freeze does not remove or correct anything on your report, and companies you already have accounts with can generally still see it. Some specialty agencies, such as ChexSystems, LexisNexis, Innovis and NCTUE, offer their own freezes.',
      es: 'Un congelamiento de seguridad, también llamado congelamiento de crédito, restringe el acceso a su expediente para crédito nuevo, lo que dificulta que otra persona abra cuentas a su nombre. En Experian, Equifax y TransUnion es gratuito por ley federal. Se pide por separado en cada agencia, y lo pide usted: nosotros no podemos solicitarlo en su nombre. Permanece hasta que usted lo levante, y generalmente debe levantarlo antes de solicitar crédito nuevo. Un congelamiento no elimina ni corrige nada de su informe, y las empresas con las que ya tiene cuentas generalmente pueden seguir viéndolo. Algunas agencias especializadas, como ChexSystems, LexisNexis, Innovis y NCTUE, ofrecen sus propios congelamientos.',
    },
    links: [PROTECT, IDT],
  },
  {
    id: 'fraud-alert',
    question: { en: 'What is a fraud alert?', es: '¿Qué es una alerta de fraude?' },
    keywords: ['fraud alert', 'alert', 'initial alert', 'extended alert', 'alerta de fraude', 'alerta'],
    answer: {
      en: 'A fraud alert is a free note on your credit file that asks businesses to confirm it is really you before opening new credit. It is for people who are, or suspect they may be, affected by identity theft. An initial alert generally lasts 1 year; an extended alert, for people with an identity theft report, generally lasts 7 years. You ask one of the three bureaus yourself, and it must tell the other two. Unlike a freeze, an alert does not block access to your file, and it does not remove or correct anything on it.',
      es: 'Una alerta de fraude es una nota gratuita en su expediente que pide a las empresas confirmar que realmente es usted antes de abrir crédito nuevo. Es para personas que son, o sospechan que pueden ser, afectadas por el robo de identidad. Una alerta inicial generalmente dura 1 año; una alerta extendida, para personas con un informe de robo de identidad, generalmente dura 7 años. Usted mismo la pide a una de las tres agencias, y esta debe avisar a las otras dos. A diferencia del congelamiento, la alerta no bloquea el acceso a su expediente, ni elimina o corrige nada de lo que contiene.',
    },
    links: [PROTECT, IDT],
  },
  {
    id: 'prescreen-opt-out',
    question: { en: 'How do I stop preapproved credit offers (opt out)?', es: '¿Cómo dejo de recibir ofertas de crédito preaprobadas (exclusión)?' },
    keywords: ['opt out', 'opt-out', 'optout', 'optoutprescreen', 'prescreened', 'prescreen', 'preapproved', 'pre-approved offers', 'credit card offers', 'junk mail', 'marketing lists', 'ofertas preaprobadas', 'ofertas preseleccionadas', 'exclusion', 'excluirme', 'correo no deseado'],
    answer: {
      en: 'Lenders and insurers can ask the credit bureaus for lists of people who meet their criteria and send them prescreened offers. You have a right to opt out of those lists. At OptOutPrescreen.com, the bureaus’ official site, or by phone, you can generally opt out for five years, or permanently by returning a signed form, and you can opt back in later. It is a request you make yourself. Opting out limits how your file is used for these offers. It does not change or delete anything on your credit reports, and it does not stop offers based on lists from other sources. Some specialty agencies, such as LexisNexis and NCTUE, have separate opt-outs that cover only their own lists.',
      es: 'Los prestamistas y las aseguradoras pueden pedir a las agencias de crédito listas de personas que cumplen sus criterios y enviarles ofertas preseleccionadas. Usted tiene derecho a excluirse de esas listas. En OptOutPrescreen.com, el sitio oficial de las agencias, o por teléfono, generalmente puede excluirse por cinco años, o de forma permanente devolviendo un formulario firmado, y puede volver a incluirse después. Es una solicitud que hace usted mismo. Excluirse limita cómo se usa su expediente para estas ofertas. No cambia ni borra nada de sus informes de crédito, y no detiene las ofertas basadas en listas de otras fuentes. Algunas agencias especializadas, como LexisNexis y NCTUE, tienen exclusiones aparte que cubren solo sus propias listas.',
    },
    links: [PROTECT, { label: { en: 'OptOutPrescreen.com (official)', es: 'OptOutPrescreen.com (oficial)' }, href: 'https://www.optoutprescreen.com/' }],
  },
  {
    id: 'freeze-alert-optout-dispute',
    question: { en: 'Freeze, fraud alert, opt-out or dispute: what is the difference?', es: 'Congelamiento, alerta de fraude, exclusión o disputa: ¿cuál es la diferencia?' },
    keywords: ['difference between', 'freeze or fraud alert', 'freeze vs', 'freeze versus', 'alert or freeze', 'which one', 'protect my file', 'protect my credit', 'protect your file', 'does a freeze remove', 'freeze or dispute', 'diferencia entre', 'congelamiento o alerta', 'cual me conviene', 'proteger mi expediente', 'proteger mi credito'],
    answer: {
      en: 'They do four different jobs. A security freeze restricts who can get your file for new credit. A fraud alert leaves the file open but asks businesses to confirm your identity first; it is for people who are, or suspect they may be, affected by identity theft. An opt-out takes you off lists used for prescreened offers or marketing. None of those three changes what a report says. A dispute is the only one about the content: it asks the agency to investigate information you believe is inaccurate, incomplete or unverifiable, and the agency decides. Freezes, alerts and opt-outs are generally free and are requested by you, directly with each agency; we cannot place them for you.',
      es: 'Cumplen cuatro funciones distintas. Un congelamiento de seguridad restringe quién puede obtener su expediente para crédito nuevo. Una alerta de fraude deja el expediente abierto pero pide a las empresas confirmar primero su identidad; es para personas que son, o sospechan que pueden ser, afectadas por el robo de identidad. Una exclusión lo retira de las listas usadas para ofertas preseleccionadas o mercadeo. Ninguna de esas tres cambia lo que dice un informe. Una disputa es la única que trata del contenido: pide a la agencia investigar información que usted considera inexacta, incompleta o imposible de verificar, y la agencia decide. Los congelamientos, las alertas y las exclusiones generalmente son gratuitos y los solicita usted, directamente con cada agencia; nosotros no podemos solicitarlos en su nombre.',
    },
    links: [PROTECT, ITEMS, IDT],
  },
  {
    id: 'goodwill-letter',
    question: { en: 'What is a goodwill letter?', es: '¿Qué es una carta de buena voluntad?' },
    keywords: ['goodwill', 'goodwill letter', 'good will', 'ask the creditor', 'forgive', 'courtesy', 'carta de buena voluntad', 'buena voluntad', 'cortesia', 'perdonar'],
    answer: {
      en: 'A goodwill letter is a polite request to a creditor to reconsider how it reports something that is accurate — typically a single late payment on an account that is otherwise in good standing. It is not a dispute: you are not saying the information is wrong, you are asking for a courtesy. Creditors are not required to agree and many do not, so it is a request with no assurance of any result.',
      es: 'Una carta de buena voluntad es una petición cortés a un acreedor para que reconsidere cómo reporta algo que es exacto — normalmente un solo pago atrasado en una cuenta que por lo demás está al día. No es una disputa: usted no dice que la información esté mal, pide una cortesía. Los acreedores no están obligados a aceptar y muchos no lo hacen, así que es una petición sin ninguna seguridad de resultado.',
    },
    links: [LETTERS],
  },
  {
    id: 'authorized-user',
    question: { en: 'What is an authorised user?', es: '¿Qué es un usuario autorizado?' },
    keywords: ['authorized user', 'authorised user', 'added to a card', 'piggyback', 'someone elses card', 'usuario autorizado', 'tarjeta de otra persona', 'agregar a una tarjeta'],
    answer: {
      en: 'An authorised user is someone added to another person’s credit card account. Some card issuers report the account on the authorised user’s credit report as well, so its history — good or bad — can appear there. Whether and how it counts depends on the issuer and the scoring model, so this is general education, not a recommendation. The account owner stays responsible for the debt.',
      es: 'Un usuario autorizado es alguien añadido a la cuenta de tarjeta de crédito de otra persona. Algunos emisores también reportan la cuenta en el informe del usuario autorizado, por lo que su historial — bueno o malo — puede aparecer ahí. Si cuenta y cómo depende del emisor y del modelo de puntaje, así que esto es educación general, no una recomendación. El titular de la cuenta sigue siendo responsable de la deuda.',
    },
  },
  {
    id: 'secured-card',
    question: { en: 'What is a secured credit card?', es: '¿Qué es una tarjeta de crédito asegurada?' },
    keywords: ['secured card', 'secured credit card', 'deposit card', 'build credit', 'rebuild credit', 'no credit', 'start credit', 'credit builder', 'tarjeta asegurada', 'tarjeta garantizada', 'construir credito', 'reconstruir credito', 'sin credito', 'sin historial'],
    answer: {
      en: 'A secured card is a credit card backed by a cash deposit, which usually sets your limit. It is typically easier to get with little or damaged credit history. If the issuer reports to the bureaus — most do, but check — on-time payments build a positive record over time. This is general education, not a recommendation of any product; compare fees and terms before applying.',
      es: 'Una tarjeta asegurada es una tarjeta de crédito respaldada por un depósito en efectivo, que por lo general fija su límite. Normalmente es más fácil de obtener con poco historial o con historial dañado. Si el emisor reporta a las agencias — la mayoría lo hace, pero confírmelo — los pagos puntuales forman un historial positivo con el tiempo. Esto es educación general, no una recomendación de ningún producto; compare cargos y condiciones antes de solicitarla.',
    },
  },
  {
    id: 'croa-rights',
    question: { en: 'What can a credit repair company legally do, and not do?', es: '¿Qué puede y qué no puede hacer legalmente una empresa de reparación de crédito?' },
    keywords: ['credit repair company', 'credit repair', 'croa', 'legal', 'legally', 'allowed', 'my rights', 'rights', 'scam', 'legit', 'what can you do', 'what do you do', 'reparacion de credito', 'empresa de reparacion', 'mis derechos', 'derechos', 'estafa', 'que pueden hacer'],
    answer: {
      en: 'Under the federal Credit Repair Organizations Act (CROA), a credit repair company must give you a written contract and a statement of your rights, cannot charge for a service before it has been fully performed, cannot promise a specific result, and cannot advise you to make false statements. You may cancel within 3 business days of signing at no charge. It can help you review reports and prepare disputes of information you believe is inaccurate — things you are also free to do yourself at no cost.',
      es: 'Según la ley federal de organizaciones de reparación de crédito (CROA), una empresa de reparación de crédito debe darle un contrato por escrito y una declaración de sus derechos, no puede cobrar por un servicio antes de haberlo prestado por completo, no puede prometer un resultado específico y no puede aconsejarle hacer declaraciones falsas. Usted puede cancelar dentro de los 3 días hábiles posteriores a la firma sin costo. Puede ayudarle a revisar informes y preparar disputas de información que usted crea inexacta — cosas que también puede hacer por su cuenta sin costo.',
    },
    links: [AGREEMENTS, CFPB],
  },
  {
    id: 'diy',
    question: { en: 'Can I dispute on my own for free?', es: '¿Puedo disputar por mi cuenta, gratis?' },
    keywords: ['myself', 'on my own', 'by myself', 'diy', 'do it myself', 'without a company', 'for free', 'no cost', 'por mi cuenta', 'yo mismo', 'yo misma', 'sin empresa', 'sin costo'],
    answer: {
      en: 'Yes. You have the right to dispute inaccurate information directly with each credit bureau and with the company that reported it, at no cost — online, by phone or by mail. A credit repair company does nothing you could not do yourself; what you are paying for is the time and organisation. Each bureau explains its dispute process on its own website.',
      es: 'Sí. Usted tiene derecho a disputar información inexacta directamente con cada agencia de crédito y con la empresa que la reportó, sin costo — por internet, por teléfono o por correo. Una empresa de reparación de crédito no hace nada que usted no pueda hacer por su cuenta; lo que paga es el tiempo y la organización. Cada agencia explica su proceso de disputa en su propio sitio web.',
    },
    links: [CFPB],
  },
  {
    id: 'cancel',
    question: { en: 'Can I cancel my agreement?', es: '¿Puedo cancelar mi acuerdo?' },
    keywords: ['cancel', 'cancellation', 'cancel my agreement', 'cancel my contract', 'cancel service', 'refund', '3 days', 'three days', 'change my mind', 'cancelar', 'cancelacion', 'cancelar mi contrato', 'cancelar mi acuerdo', 'reembolso', '3 dias', 'tres dias'],
    answer: {
      en: 'Federal law gives you 3 business days after signing a credit repair contract to cancel it without paying anything, and the contract must come with a cancellation form. After that window, cancellation follows the terms of your agreement, which you can read at any time. For questions about your own agreement or billing, ask your specialist.',
      es: 'La ley federal le da 3 días hábiles después de firmar un contrato de reparación de crédito para cancelarlo sin pagar nada, y el contrato debe incluir un formulario de cancelación. Pasado ese plazo, la cancelación sigue los términos de su acuerdo, que puede leer en cualquier momento. Para preguntas sobre su propio acuerdo o su facturación, consulte a su especialista.',
    },
    links: [AGREEMENTS, MESSAGES],
  },
  {
    id: 'fees',
    question: { en: 'When can a credit repair company charge me?', es: '¿Cuándo puede cobrarme una empresa de reparación de crédito?' },
    keywords: ['fee', 'fees', 'charge me', 'advance fee', 'upfront', 'up front', 'pay first', 'cost', 'price', 'how much', 'billing', 'cargo', 'cargos', 'cobrar', 'cobro', 'por adelantado', 'anticipado', 'costo', 'precio', 'cuanto cuesta', 'facturacion'],
    answer: {
      en: 'Under federal law a credit repair company cannot charge or collect payment for a service until that service has been fully performed — no advance fees for work not yet done. Your contract must state the total cost and describe the services. Some states add their own rules. For what you are being billed and why, ask your specialist.',
      es: 'Según la ley federal, una empresa de reparación de crédito no puede cobrar ni recibir pago por un servicio hasta haberlo prestado por completo: no hay cargos anticipados por trabajo aún no realizado. Su contrato debe indicar el costo total y describir los servicios. Algunos estados añaden sus propias reglas. Para saber qué se le está cobrando y por qué, consulte a su especialista.',
    },
    links: [AGREEMENTS, MESSAGES],
  },
  {
    id: 'results',
    question: { en: 'How long does credit repair take, and what results can I expect?', es: '¿Cuánto tarda la reparación de crédito y qué resultados puedo esperar?' },
    keywords: ['how long does credit repair take', 'how fast', 'how soon', 'how many points', 'points', 'will my score go up', 'raise my score', 'improve my score', 'increase my score', 'expect', 'promise', 'approved', 'approval', 'mortgage', 'loan', 'que tan rapido', 'cuantos puntos', 'puntos', 'subir mi puntaje', 'mejorar mi puntaje', 'esperar', 'aprobacion', 'hipoteca', 'prestamo'],
    answer: {
      en: 'There is no honest way to predict it. Each dispute typically takes a month or more, and the bureaus and reporting companies make every decision. No one can promise that an item changes, that a score moves, or that a lender approves an application. What is within your control is generally: checking that your reports are accurate, paying current accounts on time, and keeping card balances low relative to their limits.',
      es: 'No hay una forma honesta de predecirlo. Cada disputa normalmente toma un mes o más, y las agencias y las empresas que reportan toman cada decisión. Nadie puede prometer que un dato cambie, que un puntaje se mueva o que un prestamista apruebe una solicitud. Lo que generalmente está en sus manos es: confirmar que sus informes sean exactos, pagar a tiempo sus cuentas actuales y mantener bajos los saldos de sus tarjetas en relación con sus límites.',
    },
  },

  // ---- How the client portal works ---------------------------------------------------------------------------------
  // Specialty agencies. Facts read on each agency's own site on 2026-11-19 (sources in src/lib/credit/agencies.ts);
  // the five-year figure is ChexSystems' own stated practice, so it is attributed to ChexSystems and not given as a rule.
  {
    id: 'bank-reports',
    question: { en: 'What are ChexSystems and Early Warning, and why would a bank turn me down?', es: '¿Qué son ChexSystems y Early Warning, y por qué un banco me rechazaría?' },
    keywords: ['chexsystems', 'chex systems', 'chex', 'early warning', 'ews', 'denied a bank account', 'bank account denied', 'open a bank account', 'bank turned me down', 'closed my account', 'bank closed', 'checking account', 'savings account', 'overdraft', 'cuenta bancaria', 'cuenta de cheques', 'cuenta de ahorros', 'me negaron una cuenta', 'abrir una cuenta', 'cuenta cerrada', 'sobregiro'],
    answer: {
      en: 'ChexSystems and Early Warning Services are specialty consumer reporting agencies, not credit bureaus. Banks and credit unions report checking and savings account history to them, typically an account the bank closed, and may check them when you apply for a new account. ChexSystems says its current practice is to keep a reported record for five years. Paying what is owed generally updates the record to show it was paid, but an accurate record typically stays on file until then. You can request your free report from each agency directly. If something on it is inaccurate or incomplete, you can dispute it with the agency, which generally has 30 days to look into it. If the record is accurate, there is nothing to dispute.',
      es: 'ChexSystems y Early Warning Services son agencias especializadas de informes del consumidor, no agencias de crédito. Los bancos y cooperativas de crédito les reportan el historial de cuentas de cheques y de ahorros, normalmente una cuenta que el banco cerró, y pueden consultarlas cuando usted solicita una cuenta nueva. ChexSystems indica que su práctica actual es conservar un registro reportado durante cinco años. Pagar lo que se debe generalmente actualiza el registro para mostrar que se pagó, pero un registro exacto normalmente permanece hasta entonces. Puede pedir su informe gratuito directamente a cada agencia. Si algo es inexacto o está incompleto, puede disputarlo ante la agencia, que generalmente tiene 30 días para revisarlo. Si el registro es exacto, no hay nada que disputar.',
    },
    links: [
      { label: { en: 'ChexSystems: request your free report', es: 'ChexSystems: pida su informe gratuito' }, href: 'https://www.chexsystems.com/request-reports/consumer-disclosure' },
      { label: { en: 'Early Warning: request your free report', es: 'Early Warning: pida su informe gratuito' }, href: 'https://www.earlywarning.com/consumer-information' },
      ITEMS,
    ],
  },
  {
    id: 'lexisnexis',
    question: { en: 'What is LexisNexis, and what is in my LexisNexis report?', es: '¿Qué es LexisNexis y qué contiene mi informe de LexisNexis?' },
    keywords: ['lexisnexis', 'lexis nexis', 'lexis', 'background report', 'background screening', 'background check', 'specialty report', 'specialty reports', 'lien', 'liens', 'judgment', 'judgments', 'professional license', 'antecedentes', 'informe especializado', 'informes especializados', 'gravamen', 'gravamenes', 'sentencia', 'sentencias'],
    answer: {
      en: 'LexisNexis Risk Solutions is a consumer reporting agency that gathers public records and other data instead of credit accounts. Its Consumer Disclosure Report typically includes property ownership and transactions, liens, judgments and bankruptcies, professional licenses and past addresses. Insurers, financial institutions and others may use that information. You can request your free report online, by mail or by phone. If an entry is inaccurate or incomplete, for example a record that belongs to someone with a similar name, you can dispute it with LexisNexis, which generally has 30 days to look into it. Records that are accurate generally stay on file, and there is nothing to dispute about them.',
      es: 'LexisNexis Risk Solutions es una agencia de informes del consumidor que reúne registros públicos y otros datos en lugar de cuentas de crédito. Su informe (Consumer Disclosure Report) normalmente incluye propiedad y transacciones de inmuebles, gravámenes, sentencias y bancarrotas, licencias profesionales y direcciones anteriores. Aseguradoras, instituciones financieras y otros pueden usar esa información. Puede pedir su informe gratuito en línea, por correo o por teléfono. Si un dato es inexacto o está incompleto, por ejemplo un registro que pertenece a alguien con un nombre parecido, puede disputarlo ante LexisNexis, que generalmente tiene 30 días para revisarlo. Los registros exactos generalmente permanecen, y no hay nada que disputar sobre ellos.',
    },
    links: [
      { label: { en: 'LexisNexis: request your free report', es: 'LexisNexis: pida su informe gratuito' }, href: 'https://consumer.risk.lexisnexis.com/consumer' },
      ITEMS,
    ],
  },
  {
    id: 'portal-upload', audience: 'portal',
    question: { en: 'How do I upload a document?', es: '¿Cómo subo un documento?' },
    keywords: ['upload', 'uploading', 'send a document', 'send documents', 'send my id', 'photo id', 'proof of address', 'attach', 'file', 'pdf', 'subir', 'subir documento', 'enviar documento', 'enviar documentos', 'identificacion', 'comprobante', 'archivo', 'adjuntar'],
    answer: {
      en: 'Open Documents, choose what the file is (for example Photo ID or Credit report), pick the file and upload it. PDF, PNG and JPG files are accepted (the size limit is shown on the upload form), and it works from a phone. If your specialist asked for something specific, it is listed on your Home page under “What we need from you”. Credit reports should be sent as PDFs so they can be read automatically.',
      es: 'Abra Documentos, elija qué es el archivo (por ejemplo Identificación con foto o Informe de crédito), seleccione el archivo y súbalo. Se aceptan archivos PDF, PNG y JPG (el límite de tamaño aparece en el formulario), y funciona desde el teléfono. Si su especialista le pidió algo específico, aparece en su página de Inicio bajo “Lo que necesitamos de usted”. Los informes de crédito deben enviarse en PDF para que puedan leerse automáticamente.',
    },
    links: [DOCS],
  },
  {
    id: 'portal-sign', audience: 'portal',
    question: { en: 'How do I sign my agreements?', es: '¿Cómo firmo mis acuerdos?' },
    keywords: ['sign', 'signing', 'signature', 'agreement', 'agreements', 'contract', 'consent', 'authorization', 'firmar', 'firma', 'acuerdo', 'acuerdos', 'contrato', 'consentimiento', 'autorizacion'],
    answer: {
      en: 'Open Profile and go to Agreements. Read each document, tick the box to confirm you have read it, type your full legal name and choose Sign. Work on your file cannot start until the required agreements are signed. Take your time reading them, and message your specialist before signing if anything is unclear.',
      es: 'Abra Perfil y vaya a Acuerdos. Lea cada documento, marque la casilla para confirmar que lo leyó, escriba su nombre legal completo y elija Firmar. El trabajo en su expediente no puede empezar hasta que los acuerdos requeridos estén firmados. Léalos con calma y escriba a su especialista antes de firmar si algo no queda claro.',
    },
    links: [AGREEMENTS, MESSAGES],
  },
  {
    id: 'portal-messages', audience: 'portal',
    question: { en: 'How do I contact my specialist?', es: '¿Cómo contacto a mi especialista?' },
    keywords: ['contact', 'message', 'messages', 'talk to', 'speak to', 'specialist', 'help', 'human', 'person', 'question', 'call', 'contactar', 'mensaje', 'mensajes', 'hablar con', 'especialista', 'ayuda', 'persona', 'pregunta', 'llamar'],
    answer: {
      en: 'Open Messages and write to your specialist. Replies appear in the same place, so the whole conversation stays together. Please do not put your full Social Security number or full account numbers in a message. Your specialist is the right person for anything about your own accounts, your agreement or your billing.',
      es: 'Abra Mensajes y escriba a su especialista. Las respuestas aparecen en el mismo lugar, así toda la conversación queda junta. Por favor no incluya su número completo de Seguro Social ni números de cuenta completos en un mensaje. Su especialista es la persona indicada para todo lo relacionado con sus propias cuentas, su acuerdo o su facturación.',
    },
    links: [MESSAGES],
  },
  {
    id: 'portal-letters', audience: 'portal',
    question: { en: 'Where can I see my letters?', es: '¿Dónde puedo ver mis cartas?' },
    keywords: ['letters', 'letter', 'see my letters', 'download letter', 'what was sent', 'copy of the letter', 'cartas', 'carta', 'ver mis cartas', 'descargar carta', 'que se envio', 'copia de la carta'],
    answer: {
      en: 'Open Letters. Each letter appears there once your specialist has reviewed and approved it, and you can download it as a PDF. A letter that is still being drafted is not shown yet.',
      es: 'Abra Cartas. Cada carta aparece ahí una vez que su especialista la revisó y aprobó, y puede descargarla en PDF. Una carta que todavía está en borrador aún no se muestra.',
    },
    links: [LETTERS],
  },
  {
    id: 'portal-status', audience: 'portal',
    question: { en: 'Where do I see what is happening with my case?', es: '¿Dónde veo cómo va mi caso?' },
    keywords: ['need from me', 'necesitan de mi', 'status', 'progress', 'my case', 'my items', 'update', 'updates', 'what is happening', 'whats happening', 'where am i', 'next step', 'what do i do', 'what now', 'estado', 'progreso', 'mi caso', 'mis cuentas', 'actualizacion', 'que esta pasando', 'proximo paso', 'que hago', 'que sigue'],
    answer: {
      en: 'Home shows your next step, anything your specialist needs from you, and the latest updates. My items lists every dispute that has been sent, when it went out, when a response is expected and what came back. If nothing is asked of you, there is nothing you need to do right now.',
      es: 'Inicio muestra su próximo paso, lo que su especialista necesita de usted y las últimas novedades. Mis cuentas lista cada disputa enviada, cuándo salió, cuándo se espera respuesta y qué se respondió. Si no se le pide nada, no necesita hacer nada por ahora.',
    },
    links: [{ label: { en: 'Home', es: 'Inicio' }, href: { portal: '/portal' } }, ITEMS],
  },

  // ---- How the staff app works ----------------------------------------------------------------------------------------
  {
    id: 'app-start', audience: 'app',
    question: { en: 'Where do I start with a new file?', es: '¿Por dónde empiezo con un expediente nuevo?' },
    keywords: ['start', 'get started', 'begin', 'new client', 'add a client', 'first step', 'new file', 'how does this app work', 'workflow', 'import report', 'upload report', 'empezar', 'comenzar', 'nuevo cliente', 'primer paso', 'como funciona', 'importar informe'],
    answer: {
      en: 'The usual order is: open Clients and add the person (in a personal workspace, your own file is already there); collect the required consents; import their credit reports on the Reports tab and approve each one after checking it was read correctly; open the three-bureau comparison and review the findings; start a dispute only for items believed to be inaccurate; then generate, approve and send the letter. Each file shows a short action plan on its overview with the next real step.',
      es: 'El orden habitual es: abra Clientes y añada a la persona (en un espacio personal, su propio expediente ya existe); reúna los consentimientos requeridos; importe sus informes de crédito en la pestaña Informes y apruebe cada uno después de confirmar que se leyó bien; abra la comparación de las tres agencias y revise los hallazgos; inicie una disputa solo por datos que se crean inexactos; luego genere, apruebe y envíe la carta. Cada expediente muestra en su resumen un plan breve con el siguiente paso real.',
    },
    links: [CLIENTS, { label: { en: 'Start a dispute', es: 'Iniciar una disputa' }, href: { app: '/app/disputes/new' } }],
  },
  {
    id: 'app-letters', audience: 'app',
    question: { en: 'Where are letters created and sent?', es: '¿Dónde se crean y envían las cartas?' },
    keywords: ['letters', 'letter', 'create a letter', 'generate letter', 'send letter', 'approve letter', 'mail', 'template', 'cartas', 'carta', 'crear carta', 'enviar carta', 'aprobar carta', 'plantilla', 'correo'],
    answer: {
      en: 'Letters lists every letter with its status. A letter is drafted from a dispute, then reviewed and approved by a person, and only then marked as sent. The response clock for a dispute starts when the letter is actually sent, not when it is approved. A client sees a letter in their portal once it is approved.',
      es: 'Cartas lista cada carta con su estado. Una carta se redacta a partir de una disputa, luego una persona la revisa y aprueba, y solo entonces se marca como enviada. El plazo de respuesta de una disputa empieza cuando la carta realmente se envía, no cuando se aprueba. El cliente ve la carta en su portal una vez aprobada.',
    },
    links: [LETTERS, ITEMS],
  },
  {
    id: 'app-replies', audience: 'app',
    question: { en: 'How do I record a bureau reply?', es: '¿Cómo registro la respuesta de una agencia?' },
    keywords: ['record a reply', 'record reply', 'record response', 'bureau reply', 'outcome', 'reply came', 'response came', 'read a reply', 'registrar respuesta', 'respuesta de la agencia', 'llego respuesta'],
    answer: {
      en: 'Open the dispute and record the outcome the reply states: removed, updated, verified or unresolved. You can paste the reply text into the AI assistant page for a suggested reading, but a person always chooses the outcome. Upload the reply itself to the file’s documents so there is a record.',
      es: 'Abra la disputa y registre el resultado que indica la respuesta: eliminado, actualizado, verificado o sin resolver. Puede pegar el texto de la respuesta en la página del asistente de IA para obtener una lectura sugerida, pero siempre es una persona quien elige el resultado. Suba la respuesta a los documentos del expediente para que quede constancia.',
    },
    links: [ITEMS, { label: { en: 'AI assistant: read a bureau reply', es: 'Asistente de IA: leer una respuesta' }, href: { app: '/app/assistant' } }],
  },
];

/** Starter questions offered when the panel opens, and listed by the fallback answer. */
export const STARTER_IDS: Record<GuideAudience, string[]> = {
  portal: ['how-it-works', 'portal-status', 'free-reports', 'dispute-timeline'],
  app: ['how-it-works', 'app-start', 'when-to-dispute', 'dispute-timeline'],
};

export const entriesFor = (audience: GuideAudience): GuideEntry[] => GUIDE_ENTRIES.filter((e) => !e.audience || e.audience === audience);
export const entryById = (id: string): GuideEntry | undefined => GUIDE_ENTRIES.find((e) => e.id === id);

/** Resolves a link for one audience; null when the link has no screen there. */
export function resolveLink(link: GuideLink, audience: GuideAudience, lang: Lang): { label: string; href: string } | null {
  const href = typeof link.href === 'string' ? link.href : link.href[audience];
  return href ? { label: link.label[lang], href } : null;
}
