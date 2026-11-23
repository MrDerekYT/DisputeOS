import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BESIDE, COURTESY_WORDS, polishedProgress, progressNoteIssue, progressSummary, progressWordingIssue, type ProgressStats } from '@/lib/ai/assistant';
import type { AiProvider, AiRequest } from '@/lib/ai/provider';

const EN: ProgressStats = { firstName: 'Jordan', total: 6, deleted: 2, updated: 1, verified: 1, waiting: 2, draft: 0, language: 'en' };
const ES: ProgressStats = { ...EN, language: 'es' };

/** A stand-in for the model: it records the request and answers with `fn(the text between the <source> tags)`. */
const fake = (fn: (masked: string) => string): AiProvider & { seen: AiRequest[] } => {
  const seen: AiRequest[] = [];
  return { name: 'fake', seen, complete: async (r) => { seen.push(r); return fn(/<source>\n([\s\S]*)\n<\/source>/.exec(r.user)![1]!); } };
};

describe('progress note polish: what is sent', () => {
  it('sends only the connective sentences: no name, no greeting, no counts', async () => {
    for (const [stats, kept] of [[EN, ['Here is where your case stands.', 'We will let you know about each response.']], [ES, ['Este es el estado de su caso.', 'Le avisaremos de cada respuesta.']]] as const) {
      const ai = fake((m) => m);
      await polishedProgress(stats, ai);
      expect(ai.seen).toHaveLength(1);
      const masked = /<source>\n([\s\S]*)\n<\/source>/.exec(ai.seen[0]!.user)![1]!;
      expect(masked.split('\n')[0]).toBe('[[LOCKED_1]]'); // the greeting line
      for (const k of kept) expect(masked).toContain(k);
      const sent = `${ai.seen[0]!.system}\n${ai.seen[0]!.user}`;
      for (const secret of ['Jordan', 'first_name', 'Hi ', 'Hola ']) expect(sent, secret).not.toContain(secret);
      expect(masked.replace(/\[\[LOCKED_\d+\]\]/g, '')).not.toMatch(/\d/);
    }
  });

  it('a name that is also a word locks nothing else, and is not sent either', async () => {
    const ai = fake((m) => m);
    await polishedProgress({ ...EN, firstName: 'Will' }, ai);
    const user = ai.seen[0]!.user;
    expect(user).toContain('We will let you know about each response.');
    expect(user).not.toMatch(/\bWill\b/);
  });

  it('is not called without a provider, and returns the drafted note', async () => {
    expect(await polishedProgress(EN, null)).toEqual({ text: progressSummary(EN), usedAi: false, provider: 'rules' });
  });
});

describe('progress note polish: what comes back', () => {
  it('accepts a natural rewording and puts the client’s name back', async () => {
    const r = await polishedProgress(EN, fake((m) => m.replace('Here is where your case stands.', 'Here is a quick update on your case.').replace('We will let you know about each response.', 'We will keep you posted as each response arrives.')));
    expect(r.usedAi).toBe(true);
    expect(r.text).toBe(progressSummary(EN).replace('Here is where your case stands.', 'Here is a quick update on your case.').replace('We will let you know about each response.', 'We will keep you posted as each response arrives.'));
    expect(r.text.startsWith('Hi Jordan,\n\nHere is a quick update on your case. Of 6 disputed items, 3 changed (2 removed, 1 corrected)')).toBe(true);
    const es = await polishedProgress(ES, fake((m) => m.replace('Le avisaremos de cada respuesta.', 'Le avisaremos en cuanto llegue cada respuesta.')));
    expect(es).toMatchObject({ usedAi: true });
    expect(es.text.startsWith('Hola Jordan,\n\nEste es el estado de su caso.')).toBe(true);
    // A name with characters that mean something to String.replace comes back exactly.
    expect((await polishedProgress({ ...EN, firstName: 'Jo$&e' }, fake((m) => m.replace('Here is where', 'This is where')))).text.split('\n')[0]).toBe('Hi Jo$&e,');
  });

  // The four replies the scope report's probe saw accepted and charged, and the rewrites this change also rejects.
  it.each([
    ['ES: an added removal promise', ES, (m: string) => `${m} Eliminaremos sus cuentas negativas muy pronto.`, /added or dropped a sentence/],
    ['EN: an added vague promise', EN, (m: string) => `${m} We will clean up your credit very soon.`, /added or dropped a sentence/],
    ['EN: the <source> wrapper echoed', EN, (m: string) => `<source>\n${m}\n</source>`, /changed the number of lines/],
    ['EN: a preface line', EN, (m: string) => `Here is the polished note:\n\n${m}`, /changed the number of lines/],
    ['EN: a preface on the greeting line', EN, (m: string) => `Here is the polished note: ${m}`, /added wording around a protected passage/],
    ['EN: a sentence dropped', EN, (m: string) => m.replace(' We will let you know about each response.', ''), /added or dropped a sentence/],
    ['EN: a score promise in place of a sentence', EN, (m: string) => m.replace('We will let you know about each response.', 'Your score will go up soon.'), /used a word outside the courtesy wording \(“score”\)/],
    ['ES: a score promise in place of a sentence', ES, (m: string) => m.replace('Le avisaremos de cada respuesta.', 'Su puntaje subirá pronto.'), /used a word outside the courtesy wording \(“puntaje”\)/],
    ['EN: markdown formatting', EN, (m: string) => m.replace('Here is where your case stands.', '**Here is where your case stands.**'), /character outside the courtesy wording \(“\*\*”\)/],
  ] as const)('rejects %s, and keeps the drafted note', async (_label, stats, reply, why) => {
    const r = await polishedProgress(stats, fake(reply));
    expect(r.usedAi).toBe(false);
    expect(r.text).toBe(progressSummary(stats));
    expect(r.note).toMatch(why);
  });

  // The only wording the model may change is two courtesy sentences, so a rewording of one that talks about a result or
  // what is about to happen is rejected however it is phrased (the review's examples, and the same family).
  const EN_FROM = 'Here is where your case stands.';
  const EN_LAST = 'We will let you know about each response.';
  const ES_FROM = 'Este es el estado de su caso.';
  const ES_LAST = 'Le avisaremos de cada respuesta.';
  it.each([
    [EN, EN_FROM, 'Good news: the remaining negative items should come off soon.'],
    [EN, EN_FROM, 'We expect your score to climb once the remaining items are resolved.'],
    [EN, EN_FROM, 'Your credit is about to get much better.'],
    [EN, EN_FROM, 'Your score should improve soon.'],
    [EN, EN_FROM, 'You are on track for a clean credit history.'],
    [EN, EN_FROM, 'Expect a much higher score very soon.'],
    [EN, EN_FROM, 'The negative items should be gone soon.'],
    [EN, EN_FROM, 'Things are likely to get better from here.'],
    [EN, EN_FROM, 'You will be approved for that loan.'],
    [EN, EN_LAST, 'We will let you know about each response, and you will be happy with what comes next.'],
    [EN, EN_LAST, 'We’ll let you know about each response; it’ll be over soon.'],
    [ES, ES_FROM, 'Pronto tendrá un historial de crédito limpio.'],
    [ES, ES_FROM, 'Su crédito está a punto de mejorar mucho.'],
    [ES, ES_FROM, 'Su puntaje debería subir pronto.'],
    [ES, ES_FROM, 'Probablemente sus cuentas negativas se borren.'],
    [ES, ES_FROM, 'Esperamos que le aprueben el préstamo.'],
    [ES, ES_LAST, 'Le avisaremos de cada respuesta y verá cambios.'],
  ] as const)('rejects a reworded sentence that mentions a result or a prediction: %#', async (stats, from, to) => {
    const r = await polishedProgress(stats, fake((m) => m.replace(from, to)));
    expect(r.usedAi, to).toBe(false);
    expect(r.text).toBe(progressSummary(stats));
    expect(r.note).toMatch(/^AI rewrite discarded: /);
  });

  it.each([
    [EN, [[EN_FROM, 'Here is a quick update on your case.'], [EN_LAST, 'We will keep you posted as each response arrives.']]],
    [EN, [[EN_FROM, 'Here’s where things stand with your case.'], [EN_LAST, 'We’ll let you know as soon as each response comes in.']]],
    [EN, [[EN_FROM, 'This is an update on your case.'], [EN_LAST, 'We will be in touch about every response we receive.']]],
    [ES, [[ES_FROM, 'Aquí tiene un resumen de su caso.'], [ES_LAST, 'Le avisaremos tan pronto como llegue cada respuesta.']]],
    [ES, [[ES_FROM, 'Así va su caso.'], [ES_LAST, 'Le mantendremos al tanto de cada respuesta.']]],
  ] as const)('accepts a harmless rewording of the courtesy sentences: %#', async (stats, swaps) => {
    const r = await polishedProgress(stats, fake((m) => swaps.reduce((t, [a, b]) => t.replace(a, b), m)));
    expect(r.note).toBeUndefined();
    expect(r.usedAi).toBe(true);
    expect(r.text).toBe(swaps.reduce((t, [a, b]) => t.replace(a, b), progressSummary(stats)));
  });

  // The verifier's examples after the first fix (scratchpad verify-fix/ai/ai1-promise.test.ts and ai1-more.test.ts): a
  // word list of results let these through, because they reuse the one "will" of the last sentence or name no listed
  // word. Under the list of courtesy words every one is refused, and the harmless rewordings still pass.
  it.each([
    [EN, EN_LAST, 'We will get these negatives off your file.'],
    [EN, EN_LAST, 'We will win your case.'],
    [EN, EN_FROM, 'Those negative items are history.'],
    [ES, ES_LAST, 'Ganaremos su caso.'],
    [EN, EN_LAST, 'You will be thrilled with the results.'],
    [EN, EN_LAST, 'You will love the outcome.'],
    [EN, EN_LAST, 'Lenders will love you.'],
    [EN, EN_LAST, 'We will get great results for you.'],
    [EN, EN_LAST, 'We are going to win this for you.'],
    [EN, EN_FROM, 'Your file is nearly spotless.'],
    [EN, EN_FROM, 'Your case is a sure win.'],
    [EN, EN_FROM, 'Great results are on the horizon.'],
    [EN, EN_FROM, 'Brighter days are ahead for your case.'],
    [EN, EN_FROM, 'The bad marks are off your record.'],
    [EN, EN_FROM, 'Your case is basically won.'],
    [ES, ES_LAST, 'Le encantarán los resultados.'],
    [ES, ES_LAST, 'Tendrá un historial impecable.'],
    [ES, ES_LAST, 'Conseguiremos excelentes resultados para usted.'],
    [ES, ES_LAST, 'Lograremos sacar esas cuentas negativas de su expediente.'],
    [ES, ES_FROM, 'Su caso está prácticamente ganado.'],
    [ES, ES_FROM, 'Sus cuentas negativas ya son historia.'],
  ] as const)('refuses a promise worded with no listed result word: %#', async (stats, from, to) => {
    const ai = fake((m) => m.replace(from, to));
    const r = await polishedProgress(stats, ai);
    expect(ai.seen).toHaveLength(1);
    expect(r.usedAi, to).toBe(false);
    expect(r.text).toBe(progressSummary(stats));
    expect(r.note).toMatch(/^AI rewrite discarded: /);
    // The courtesy words refuse it on their own, whatever an earlier check said.
    expect(progressWordingIssue([{ was: from, now: to }], stats.language)).toMatch(/^it used a word outside the courtesy wording \(“.+”\)$/);
  });

  it.each([
    [EN, EN_FROM, 'Here is a short update on your case.'],
    [EN, EN_LAST, 'We will be in touch as each response arrives.'],
    [EN, EN_LAST, 'We’ll keep you posted on every response.'],
    [EN, EN_LAST, 'You will hear from us about each response.'],
    [EN, EN_LAST, 'Thank you for your patience.'],
    [EN, EN_LAST, 'Please message us with any questions.'],
    [ES, ES_FROM, 'Aquí tiene un resumen de su caso.'],
    [ES, ES_LAST, 'Le escribiremos cuando llegue cada respuesta.'],
    [ES, ES_LAST, 'Le mantendremos informado de cada respuesta.'],
    [ES, ES_LAST, 'Gracias por su paciencia.'],
  ] as const)('still uses a harmless rewording, the verifier’s among them: %#', async (stats, from, to) => {
    const r = await polishedProgress(stats, fake((m) => m.replace(from, to)));
    expect(r.note, to).toBeUndefined();
    expect(r.usedAi).toBe(true);
    expect(r.text).toBe(progressSummary(stats).replace(from, to));
  });

  it('the wording check allows courtesy words only, in the note’s language, and reads only the reworded sentences', () => {
    const issue = (now: string, lang: 'en' | 'es' = 'en') => progressWordingIssue([{ was: '', now }], lang);
    for (const s of [EN_FROM, EN_LAST]) expect(issue(s), s).toBeNull();
    for (const s of [ES_FROM, ES_LAST]) expect(issue(s, 'es'), s).toBeNull();
    expect(issue('We’ll keep you posted on each response.')).toBeNull();
    expect(issue('We will tell you, and you will see.')).toMatch(/outside the courtesy wording \(“see”\)/);
    expect(issue('Le informaremos de cada respuesta.', 'es')).toBeNull();
    expect(issue('Le informaremos y quedará satisfecho.', 'es')).toMatch(/\(“quedará”\)/);
    expect(issue('Here is where your credit stands.')).toMatch(/\(“credit”\)/);
    expect(issue('Este es el estado de su crédito.', 'es')).toMatch(/\(“crédito”\)/);
    // Each language's own words: a Spanish note is not reworded in English, nor the reverse.
    expect(issue('Here is where your case stands.', 'es')).toMatch(/\(“Here”\)/);
    expect(issue('Este es el estado de su caso.')).toMatch(/\(“Este”\)/);
    // Letter case, accents and the curly apostrophe make no difference.
    expect(issue('HERE’S WHERE THINGS STAND WITH YOUR CASE.')).toBeNull();
    expect(issue('Aqui tiene un resumen de su caso.', 'es')).toBeNull();
    // Only words and ordinary punctuation: no symbol, emoji or digit.
    expect(issue('Here is where your case stands 📈.')).toMatch(/character outside the courtesy wording \(“📈”\)/);
    expect(issue('Here is where your case stands & more.')).toMatch(/character outside the courtesy wording \(“&”\)/);
    expect(issue('Here is where your case stands: 100%.')).toMatch(/character outside the courtesy wording/);
    // The locked sentences (the counts, “Results vary: … the credit bureaus …”) are never among what it reads.
    expect(issue('')).toBeNull();
  });

  it('allows "quick", "short", "brief" and "breve" only beside a word for a summary, "updated" only after "you", "stand" only after "where", and "soon" and "pronto" only in "as soon as" and "tan pronto como"', () => {
    const issue = (now: string, lang: 'en' | 'es' = 'en') => progressWordingIssue([{ was: '', now }], lang);
    for (const ok of ['Here is a short update on your case.', 'Here is a quick look at your case.', 'This is a brief summary of your case.', 'We will keep you updated on each response.', 'We’ll let you know as soon as each response comes in.']) expect(issue(ok), ok).toBeNull();
    for (const ok of ['Este es un breve resumen de su caso.', 'Aquí tiene un resumen breve de su caso.', 'Le avisaremos tan pronto como llegue cada respuesta.']) expect(issue(ok, 'es'), ok).toBeNull();
    expect(issue('Your case will be quick.')).toMatch(/\(“quick”\)/);
    expect(issue('This will be short.')).toMatch(/\(“short”\)/);
    expect(issue('Your file will be updated.')).toMatch(/\(“updated”\)/);
    // "Stand" only after "where": where a case stands, never that it will stand.
    expect(issue('Here’s where things stand with your case.')).toBeNull();
    expect(issue('Your case will stand.')).toMatch(/\(“stand”\)/);
    expect(issue('Your case stands, and we will let you know about each response.')).toMatch(/\(“stands”\)/);
    expect(issue('We will let you know soon.')).toMatch(/\(“soon”\)/);
    expect(issue('Su caso será breve.', 'es')).toMatch(/\(“será”\)/);
    expect(issue('Le avisaremos pronto.', 'es')).toMatch(/\(“pronto”\)/);
    // Nothing on the lists says that something goes away: no "off", "away" or "up", no Spanish "se" ("se va").
    expect(issue('We will get it all off your file.')).toMatch(/\(“off”\)/);
    expect(issue('Things will look up.')).toMatch(/\(“up”\)/);
    expect(issue('Lo que tiene su expediente se va.', 'es')).toMatch(/\(“se”\)/);
  });

  it('every word of the drafted courtesy sentences is on the list, so a faithful rewording is never refused for its words', () => {
    for (const [lang, sentences] of [['en', [EN_FROM, EN_LAST]], ['es', [ES_FROM, ES_LAST]]] as const) {
      const listed = [...COURTESY_WORDS[lang], ...BESIDE[lang].words, ...BESIDE[lang].afterYou, ...BESIDE[lang].afterWhere].map((x) => x.normalize('NFD').replace(/\p{M}/gu, ''));
      for (const s of sentences) {
        expect(progressWordingIssue([{ was: s, now: s }], lang), s).toBeNull();
        for (const w of s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').match(/\p{L}+/gu)!) expect(listed, `${lang}: ${w}`).toContain(w);
      }
    }
    // Nothing on the list names a result, a prediction or a feeling (a sample of the words the review's examples use).
    const all = [...COURTESY_WORDS.en, ...COURTESY_WORDS.es, ...BESIDE.en.words, ...BESIDE.es.words];
    for (const bad of ['credit', 'score', 'remove', 'win', 'won', 'clean', 'better', 'approved', 'soon', 'today', 'new', 'should', 'expect', 'good', 'great', 'happy', 'love', 'not', 'off', 'up', 'history', 'items', 'negative',
      'crédito', 'puntaje', 'eliminar', 'ganaremos', 'limpio', 'mejor', 'pronto', 'hoy', 'nuevo', 'debería', 'resultados', 'historial', 'cuentas', 'tendrá', 'será', 'no']) expect(all, bad).not.toContain(bad);
  });

  it('docs/INTEGRATIONS.md lists exactly the words that are checked', () => {
    const doc = readFileSync(path.join(process.cwd(), 'docs/INTEGRATIONS.md'), 'utf8').replace(/\s+/g, ' ');
    expect(doc).toContain(`English: ${COURTESY_WORDS.en.join(', ')}; "quick", "short" and "brief" only next to update, updates, summary, overview or look; "updated" only right after "you"; "stand" and "stands" only after "where"; and the phrase "as soon as".`);
    expect(doc).toContain(`Spanish: ${COURTESY_WORDS.es.join(', ')}; "breve" only next to resumen or actualización; and the phrase "tan pronto como".`);
    expect(BESIDE).toEqual({
      en: { words: ['quick', 'short', 'brief'], summaries: ['update', 'updates', 'summary', 'overview', 'look'], afterYou: ['updated'], afterWhere: ['stand', 'stands'] },
      es: { words: ['breve'], summaries: ['resumen', 'actualización'], afterYou: [], afterWhere: [] },
    });
  });

  it('tells the model the words, in the note’s language, and sends nothing else new', async () => {
    for (const [stats, has, hasNot] of [[EN, ['as soon as', 'quick, short, brief only next to update', 'updated only after “you”', 'stand, stands only after “where”', ' posted '], ['avisaremos']], [ES, ['tan pronto como', 'breve only next to resumen', ' avisaremos '], ['posted', 'only after']]] as const) {
      const ai = fake((m) => m);
      await polishedProgress(stats, ai);
      const goal = /^Goal: (.*)$/m.exec(ai.seen[0]!.user)![1]!;
      for (const h of has) expect(goal, h).toContain(h);
      for (const h of hasNot) expect(goal, h).not.toContain(h);
    }
  });

  it('the drafted note passes its own checks in both languages, so a faithful rewording is never rejected by them', () => {
    for (const language of ['en', 'es'] as const) {
      for (const counts of [{ total: 6, deleted: 2, updated: 1, verified: 1, waiting: 2 }, { total: 1, deleted: 1, updated: 0, verified: 0, waiting: 0 }, { total: 0, deleted: 0, updated: 0, verified: 0, waiting: 0 }]) {
        const note = progressSummary({ ...EN, ...counts, language });
        expect(progressNoteIssue(note), note).toBeNull();
      }
    }
  });
});
