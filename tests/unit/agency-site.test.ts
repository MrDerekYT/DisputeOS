import { describe, expect, it } from 'vitest';
import { checkSite, EMPTY_SITE, orgNameIssue, parseSite, siteIssues, siteLd, siteSchema, SITE_LIMITS, starterSite, type SiteContent } from '@/lib/agency-site';
import { SITE_COPY } from '@/lib/agency-site-copy';
import { findBlockedClaims, findMarketingClaims } from '@/lib/compliance/claims';

const site = (over: Partial<SiteContent> = {}): SiteContent => ({ ...EMPTY_SITE, ...over });
const ids = (text: string) => findMarketingClaims(text).map((i) => i.id);

describe('marketing claims guard (agency website copy)', () => {
  it('rejects promised results, guaranteed removal, quoted scores and timed results in English', () => {
    const bad: [string, string][] = [
      ['We guarantee results or your money back.', 'guarantee'],
      ['Collections, late payments and charge-offs will be removed from your report.', 'certain-removal'],
      ['We remove all negative items from your credit report.', 'remove-all'],
      ['We delete collections, bankruptcies and late payments.', 'removal-promise'],
      ['Get your late payments deleted for good.', 'removal-promise'],
      ['Our clients gain 100+ points on average.', 'score-number'],
      ['Reach a 750 credit score this year.', 'score-number'],
      ['We raise your credit score so you qualify.', 'score-promise'],
      ['Fix your credit in 30 days.', 'fixed-time'],
      ['See results in as little as 45 days.', 'timed-result'],
      ['Fast results, every time.', 'timed-result'],
      ['We will get you approved for a mortgage.', 'approval-promise'],
      ['Ask about a CPN to start over.', 'new-identity'],
      ['100% success rate.', '100pct'],
    ];
    for (const [text, id] of bad) expect(ids(text), text).toContain(id);
  });

  it('rejects the same promises in Spanish', () => {
    const bad: [string, string][] = [
      ['Garantizamos resultados o le devolvemos su dinero.', 'guarantee-es'],
      ['Resultados garantizados.', 'guarantee-es'],
      ['Eliminamos todas sus cuentas negativas.', 'removal-promise'],
      ['Borraremos sus colecciones y pagos atrasados.', 'removal-promise'],
      ['Podemos eliminar cualquier cuenta de su informe.', 'removal-promise'],
      ['Suba 120 puntos con nuestro programa.', 'score-number'],
      ['Aumentamos su puntaje de crédito.', 'score-promise'],
      ['Mejore su crédito en 30 días.', 'timed-result'],
      ['Resultados rápidos para toda la familia.', 'timed-result'],
      ['Le damos un nuevo perfil de crédito.', 'new-identity-es'],
    ];
    for (const [text, id] of bad) expect(ids(text), text).toContain(id);
  });

  it('rejects "free" unless it describes a first consultation', () => {
    for (const bad of ['Free credit repair for veterans.', 'Get your free credit score today.', 'Reparación de crédito gratis.', 'Su informe gratuito con nosotros.']) expect(ids(bad), bad).toContain('free');
    for (const ok of ['Your first call is a free consultation.', 'Book a free initial consultation.', 'La primera consulta es gratis.', 'Ofrecemos una consulta inicial gratuita.']) expect(ids(ok), ok).toEqual([]);
  });

  it('accepts honest descriptions of the work, including a plain disclaimer, in both languages', () => {
    const good = [
      'We review your credit reports with you and explain each entry.',
      'We prepare dispute letters for the items you believe are inaccurate. Nothing is sent until you approve it.',
      'No result is guaranteed. The credit bureaus decide the outcome of every dispute.',
      'We cannot guarantee that a dispute will change your report.',
      'The credit bureaus generally have 30 days to investigate a dispute.',
      'Serving Austin and Travis County since 2019. Call 512-555-0100.',
      'Revisamos sus informes de crédito con usted y le explicamos cada cuenta.',
      'Preparamos cartas de disputa para las cuentas que usted considera inexactas.',
      'Nadie puede garantizar un resultado. Las agencias de crédito deciden cada disputa.',
      'Atendemos en español, de lunes a viernes.',
    ];
    for (const text of good) expect(findMarketingClaims(text), text).toEqual([]);
  });

  it('a negative word elsewhere in the sentence does not excuse a guarantee, and nothing is hidden from the other rules', () => {
    for (const bad of [
      'No worries we guarantee deletions', 'Without stress we guarantee a higher score', 'Sin complicaciones le garantizamos resultados',
      'Why not get guaranteed results today', 'Don’t wait — guaranteed deletions', "Don't wait — guaranteed deletions", 'We never stop until you get guaranteed results',
      'No other company can match our guarantee', 'No more bad credit guaranteed', 'Sin riesgo y con resultados garantizados', 'Guarenteed results', 'We guarentee a clean report',
    ]) expect(ids(bad).some((i) => i === 'guarantee' || i === 'guarantee-es'), bad).toBe(true);
    // The words around the guarantee are still read by the other rules.
    expect(ids('Without stress we guarantee a higher score')).toEqual(expect.arrayContaining(['guarantee', 'score-promise']));
    expect(ids('No fee and never a guarantee: we remove collections')).toContain('removal-promise');
    for (const ok of ['No result is guaranteed.', 'Results are never guaranteed.', 'We do not guarantee any outcome.', 'We can’t guarantee a change to your report.', 'No garantizamos resultados.', 'Ningún resultado está garantizado.', 'Trabajamos sin garantías de resultado.']) expect(ids(ok), ok).toEqual([]);
  });

  it('rejects removal claims however they are phrased, in either word order and in both languages', () => {
    for (const bad of [
      'We can remove late payments, collections and bankruptcies', 'Our experts delete collections and charge-offs', 'Removing negative items is what we do best',
      'Collections deleted. Late payments erased.', 'Delete your negative items', 'Erase bad credit legally', 'We have deleted over 10,000 negative items',
      'Le ayudamos a eliminar sus deudas del informe', 'Borre su mal crédito', 'Cobranzas eliminadas de su informe', 'Quite las cuentas negativas de su historial',
    ]) expect(ids(bad), bad).toContain('removal-promise');
  });

  it('rejects score, timed-result, promise, no-cost, approval and tradeline wording that the first rules missed', () => {
    const bad: [string, string][] = [
      ['Improve your credit score fast', 'score-promise'], ['Suba su puntaje de crédito', 'score-promise'], ['Sube tu puntaje', 'score-promise'], ['Aumente su puntaje', 'score-promise'], ['A better credit score starts here', 'score-promise'],
      ['See results within 30 days', 'timed-result'], ['Results in as few as 30 days', 'timed-result'], ['30-day results', 'timed-result'], ['results in two weeks', 'timed-result'], ['Resultados dentro de 30 días', 'timed-result'],
      ['We promise results or your money back', 'result-promise'], ['Results or you do not pay', 'result-promise'], ['Prometemos resultados', 'result-promise'], ['100% efectivo', 'result-promise'],
      ['No cost credit repair', 'free'], ['Complimentary credit report', 'free'], ['Sin costo: reparación de crédito', 'free'], ['Credit repair for $0 down', 'free'],
      ['Qualify for the mortgage you want', 'approval-promise'], ['Authorized user tradelines for sale', 'tradelines'],
    ];
    for (const [text, id] of bad) expect(ids(text), text).toContain(id);
    for (const ok of ['Free credit consultation', 'Free 15-minute call', 'Book a no-cost consultation.', 'You can dispute inaccurate information yourself, directly with the credit bureaus, at no cost.', 'Can you promise a result? No. We can promise careful work and clear updates.', 'We explain what each collection or late payment entry on your report means.']) expect(ids(ok), ok).toEqual([]);
  });

  it('checks the business name too, because a published site shows it as its title', () => {
    expect(orgNameIssue('Northside Credit Services')).toBeNull();
    expect(orgNameIssue('Guaranteed 800 Score Credit Repair')).toMatch(/business name.*cannot be shown on a published site.*Settings/);
    const ok = { ...EMPTY_SITE, headline: 'Credit report help' };
    expect(() => checkSite({ ...ok, published: true }, 'Guaranteed 800 Score Credit Repair')).toThrow(/business name/);
    expect(checkSite({ ...ok, published: false }, 'Guaranteed 800 Score Credit Repair').headline).toBe('Credit report help');
    expect(checkSite({ ...ok, published: true }, 'Northside Credit Services').published).toBe(true);
  });

  it('leaves the existing guard unchanged for system-generated text', () => {
    expect(findBlockedClaims('Garantizamos resultados')).toEqual([]);
    expect(findBlockedClaims('No result is guaranteed.').map((i) => i.id)).toEqual(['guarantee']);
  });

  it('the fixed site copy and the starter draft pass the guard themselves', () => {
    for (const lang of ['en', 'es'] as const) for (const [k, v] of Object.entries(SITE_COPY[lang])) expect(findMarketingClaims(v), `${lang}.${k}`).toEqual([]);
    expect(Object.keys(SITE_COPY.es).sort()).toEqual(Object.keys(SITE_COPY.en).sort());
    const starter = { ...EMPTY_SITE, ...starterSite('Northside Credit Services') };
    expect(siteIssues(starter)).toEqual([]);
    expect(checkSite({ ...starter, published: true }).published).toBe(true);
  });
});

describe('website content', () => {
  it('starts empty and unpublished, and reads anything malformed as that', () => {
    expect(EMPTY_SITE).toMatchObject({ published: false, headline: '', services: [], faqs: [] });
    for (const s of [null, undefined, 'x', {}, { website: 'nope' }, { website: { published: 'yes' } }, { website: { headline: '<b>Hi</b>', published: true } }, { website: { services: Array(7).fill({ title: 'A', text: 'b' }) } }]) expect(parseSite(s)).toEqual(EMPTY_SITE);
    expect(parseSite({ website: { published: true, headline: ' Hello ' } })).toMatchObject({ published: true, headline: 'Hello' });
  });

  it('enforces plain text and the length limits', () => {
    expect(siteSchema.safeParse({ headline: 'x'.repeat(SITE_LIMITS.headline + 1) }).success).toBe(false);
    expect(siteSchema.safeParse({ about: 'x'.repeat(SITE_LIMITS.about + 1) }).success).toBe(false);
    expect(siteSchema.safeParse({ headline: 'two\nlines' }).success).toBe(false);
    expect(siteSchema.safeParse({ about: 'First paragraph.\n\nSecond paragraph.' }).success).toBe(true);
    expect(siteSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
    expect(siteSchema.safeParse({ phone: 'call <script>' }).success).toBe(false);
    expect(siteSchema.safeParse({ faqs: Array(SITE_LIMITS.items + 1).fill({ q: 'Q', a: 'A' }) }).success).toBe(false);
    expect(() => checkSite({ intro: 'Hello <img src=x onerror=alert(1)>' })).toThrow(/Introduction: Use plain text/);
    expect(() => checkSite({ services: [{ title: 'Review', text: 'ok' }, { title: '', text: 'no title' }] })).toThrow(/Service 2: Give each service a title/);
    expect(() => checkSite({ faqs: [{ q: 'Why?', a: '' }] })).toThrow(/Question 1: Each question needs an answer/);
  });

  it('refuses to save a prohibited claim and says which field and why', () => {
    expect(() => checkSite(site({ headline: 'We guarantee a clean report' }))).toThrow(/Headline: “guarantee” cannot be published\. Results cannot be guaranteed\./);
    expect(() => checkSite(site({ services: [{ title: 'Review', text: 'Fine.' }, { title: 'Deletion', text: 'We remove all negative items.' }] }))).toThrow(/^Service 2: /);
    expect(() => checkSite(site({ faqs: [{ q: '¿Cuánto sube mi puntaje?', a: 'Hasta 150 puntos.' }] }))).toThrow(/^Question 1: .*score/);
    expect(() => checkSite(site({ about: 'Free credit repair for everyone.' }))).toThrow(/About: “Free”.*first consultation/);
    expect(siteIssues(site({ headline: 'Guaranteed', about: 'Fast results' })).map((i) => i.field)).toEqual(['Headline', 'About']);
  });

  it('needs a headline to publish, but not to save a draft', () => {
    expect(() => checkSite(site({ published: true }))).toThrow(/Add a headline/);
    expect(checkSite(site({ published: false })).published).toBe(false);
    expect(checkSite(site({ published: true, headline: 'Credit report help in Austin' })).published).toBe(true);
  });

  it('structured data carries only what the agency provided', () => {
    const brand = { name: 'Northside Credit', slug: 'northside', color: null };
    const bare = siteLd({ brand, content: site({ headline: 'Hello' }), address: '' });
    expect(Object.keys(bare).sort()).toEqual(['@context', '@type', 'name', 'url']);
    expect(bare.url).toMatch(/\/a\/northside$/);
    const full = siteLd({ brand, content: site({ intro: 'We review reports.', phone: '512-555-0100', email: 'hi@northside.example', area: 'Austin, TX', hours: 'Mon–Fri' }), address: '12 Main St, Austin, TX 78701' }, 'es');
    expect(full).toMatchObject({ '@type': 'ProfessionalService', description: 'We review reports.', telephone: '512-555-0100', email: 'hi@northside.example', areaServed: 'Austin, TX', address: { streetAddress: '12 Main St, Austin, TX 78701' } });
    expect(full.url).toMatch(/\?lang=es$/);
    expect(JSON.stringify(full)).not.toMatch(/rating|review"|openingHours/i);
  });
});
