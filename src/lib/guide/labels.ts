import { tr, type Lang } from '../portal-i18n';
import { entryById, STARTER_IDS, type GuideAudience } from './knowledge';

/** Every string the chat panel shows, so the client component carries no copy of its own. */
export interface GuideLabels {
  open: string; title: string; close: string; intro: string; tryAsking: string; question: string; placeholder: string; send: string; thinking: string;
  guide: string; you: string; forYou: string; links: string; related: string; note: string; failed: string;
}

const STAFF: GuideLabels = {
  open: 'Ask the credit guide', title: 'Credit guide', close: 'Close the credit guide', intro: 'Ask how credit and disputes work, or where to find something in this app.',
  tryAsking: 'Try asking', question: 'Your question', placeholder: 'Type your question…', send: 'Send', thinking: 'Looking that up…', guide: 'Credit guide', you: 'You',
  forYou: 'For this file right now', links: 'Where to go', related: 'Related questions',
  note: 'General education, not legal or financial advice. Results are never guaranteed. It explains and links; it does not change anything.',
  failed: 'Something went wrong. Please try again.',
};

export function guideLabels(audience: GuideAudience, lang: Lang = 'en'): GuideLabels {
  if (audience === 'app') return STAFF;
  const t = tr(lang);
  return {
    open: t('g_open'), title: t('g_title'), close: t('g_close'), intro: t('g_intro'), tryAsking: t('g_try'), question: t('g_question'), placeholder: t('g_placeholder'),
    send: t('g_send'), thinking: t('g_thinking'), guide: t('g_guide'), you: t('you'), forYou: t('g_forYou'), links: t('g_links'), related: t('g_related'), note: t('g_note'), failed: t('e_generic'),
  };
}

export const guideStarters = (audience: GuideAudience, lang: Lang = 'en'): string[] =>
  STARTER_IDS[audience].map((id) => entryById(id)?.question[lang]).filter((q): q is string => !!q);
