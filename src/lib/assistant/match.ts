/**
 * Finds the clients a typed question names. No AI: it compares the words of the question with the names on the roster.
 *
 *   1. the full name, word for word ("Maria Lopez", "maria lopez's file");
 *   2. two words of one client's name close together, in either order ("Lopez, Maria", "Maria T. Lopez" for
 *      Maria Lopez, "Maria Lopez" for Maria Elena Lopez Garcia);
 *   3. a first or last name on its own, when exactly one client on the roster has it.
 *
 * Letter case, accents and punctuation are ignored. A stronger rule uses up the words it matched, so "Maria Lopez"
 * names that client and does not also raise every other Maria. A first or last name that several clients share is
 * reported as ambiguous and matches nobody. A word that is far more often an ordinary word, a month or a lender than
 * a person in a question about credit ("will", "may", "bill", "chase") never matches on its own: that client is found
 * by their full name.
 */

export interface RosterName { id: string; full_name: string }
export interface AmbiguousName {
  /** The name as the roster writes it ("Maria"). */
  word: string;
  /** How many clients have it as a first or last name. */
  count: number;
  /** Up to AMBIGUOUS_NAMES_SHOWN of them, in roster order. */
  names: string[];
}
export interface NameMatch {
  /** Client ids: the pinned client first, then by how exactly each was named, then by where in the question. */
  matched: string[];
  ambiguous: AmbiguousName[];
  /** Clients the question also named, beyond MAX_MATCHED. */
  more: number;
}

export const MAX_MATCHED = 5;
export const AMBIGUOUS_NAMES_SHOWN = 6;
const MAX_QUESTION_WORDS = 120;

/** Lower case, with accents removed: "José" and "jose" are the same word. */
export const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();

const splitWords = (s: string): string[] => s.normalize('NFC')
  .replace(/['’`´]s(?![\p{L}\p{N}])/giu, '') // "Maria's" is Maria
  .replace(/['’`´]/g, '') // O'Brien is obrien; James' is James
  .split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** The words of a name or a question, folded. */
export const nameTokens = (s: string): string[] => splitWords(fold(s));

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);
/** Parts of a surname that are not a name on their own ("de la Cruz", "van der Berg", "McDonald" is one word and unaffected). */
const PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'da', 'das', 'do', 'dos', 'di', 'van', 'von', 'der', 'den', 'ter', 'bin', 'ibn', 'al', 'le', 'du', 'st', 'san', 'santa', 'y', 'e', 'o']);

/**
 * Words that are not taken as a person's name when they stand alone: ordinary English (and a little Spanish), the
 * vocabulary of credit work, months and days, and large lenders. Several are also first or last names (Will, May,
 * Bill, Grace, Chase, Mark, Rose, Banks, Price, Long). A client with one is found by their full name instead.
 */
const STOP = new Set(`
a about above account accounts active ad add address after again against age ago ah all ally also am america american amount an and any anyone anything april are as ask at august auto away
back balance bank banks be been before being best between bill bills both bureau bureaus but by call calls can cannot capital car card cards case cases cash cc chance change charge chase check citi client clients close closed
collection collections come could court credit current customer date dates day days deal debt debts december delete deleted did discover dispute disputes do document documents does doing dollar done down dr due during
each early east eh email end equifax ever every ex experian express faith fargo february fee fees file files find finding findings first for ford friday from get give go good got grace
had has have having he help her here hi him his hold home hope house how i id if in info information inquiries inquiry into is it item items its january jr judge july june just keep know
last late later law least left lender less let letter letters lien like limit list little loan loans long look love low ma mae mail major make many march mark max may me medical message messages minor monday money month months more
mortgage most mr mrs ms much must my name named names navy need negative new next no none nor not note notes nothing november now number of off oh ok old on once one only open or other our out over own
pa page paid past pay payment payments pending people person phone plan plans please pm point points portal premier price question questions re read ready record records remove rent report reports response rest review right rose round
same saturday say score scores second see send sent september set she should show since small so some someone something soon sr ss stage start status still stop strong student sue sunday
take target task tasks tell than thank thanks that the their them then there these they thing things this those through thursday time times to today tomorrow too total transunion tuesday tv two
uh um under union until up update updates us use very vs wait want was way we wednesday week weeks well wells went were what when where which while who whom whose why will with within without work would
ye yes yesterday yet yo you your
que en con por para su sus un una es son cuenta cuentas cliente clientes carta cartas informe informes disputa disputas pago pagos cual como cuando donde quien tiene tienen esta estan
`.split(/\s+/).filter(Boolean));

/** A word that can name a person on its own. */
const distinctive = (t: string) => t.length >= 2 && !STOP.has(t) && !PARTICLES.has(t);
const startsUpper = (w: string) => /^\p{Lu}/u.test(w);

interface Named { id: string; name: string; core: string[]; first: string; last: string }

function named(r: RosterName): Named | null {
  const all = nameTokens(r.full_name);
  while (all.length > 1 && SUFFIXES.has(all[all.length - 1]!)) all.pop();
  if (!all.length) return null;
  return { id: r.id, name: r.full_name.trim(), core: all, first: all[0]!, last: all[all.length - 1]! };
}

/** The part of the written name that folds to `token`, for showing an ambiguous name as the roster writes it. */
function written(c: Named, token: string): string {
  const part = splitWords(c.name).find((p) => fold(p) === token);
  return part ?? token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * The clients `question` names among `roster`. `pinned` is a client chosen another way (the page was opened for them):
 * it is always first in `matched`, whether or not the question names it. The caller checks that the pinned id exists.
 */
export function matchClients(question: string, roster: readonly RosterName[], pinned: string | null = null): NameMatch {
  const raw = splitWords(question).slice(0, MAX_QUESTION_WORDS);
  const words = raw.map(fold);
  const people = roster.map(named).filter((p): p is Named => p !== null);
  const byToken = new Map<string, number[]>();
  const byEnd = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, k: string, i: number) => { const a = m.get(k); if (a) { if (a[a.length - 1] !== i) a.push(i); } else m.set(k, [i]); };
  people.forEach((p, i) => {
    for (const t of p.core) push(byToken, t, i);
    push(byEnd, p.first, i);
    push(byEnd, p.last, i);
  });

  const used = words.map(() => false);
  const hits = new Map<number, { rank: number; at: number }>();
  const hit = (i: number, rank: number, at: number) => { if (!hits.has(i)) hits.set(i, { rank, at }); };

  // 1. The full name, word for word. Where two names start at the same word, the longer one is the one that was typed.
  for (let at = 0; at < words.length; at++) {
    if (used[at]) continue;
    let longest = 0;
    const found: number[] = [];
    for (const i of byToken.get(words[at]!) ?? []) {
      const { core } = people[i]!;
      if (core.length < 2 || core[0] !== words[at] || !core.every((t, k) => words[at + k] === t && !used[at + k])) continue;
      // A name made only of ordinary words ("Will May") counts when it is written as a name: with capitals.
      if (!core.some(distinctive) && !core.every((_, k) => startsUpper(raw[at + k]!))) continue;
      if (core.length > longest) { longest = core.length; found.length = 0; }
      if (core.length === longest) found.push(i);
    }
    for (const i of found) hit(i, 1, at);
    for (let k = 0; k < longest; k++) used[at + k] = true;
  }

  // 2. Two words of one client's name within two words of each other, in either order.
  const pairUsed = new Set<number>();
  for (let at = 0; at < words.length; at++) {
    const t = words[at]!;
    if (used[at] || t.length < 2 || PARTICLES.has(t)) continue;
    for (const i of byToken.get(t) ?? []) {
      if (hits.has(i)) continue;
      for (let other = Math.max(0, at - 2); other <= Math.min(words.length - 1, at + 2); other++) {
        const u = words[other]!;
        if (other === at || used[other] || u === t || u.length < 2 || PARTICLES.has(u) || !people[i]!.core.includes(u)) continue;
        if (!distinctive(t) && !distinctive(u)) continue;
        hit(i, 2, Math.min(at, other));
        pairUsed.add(at).add(other);
        break;
      }
    }
  }
  for (const at of pairUsed) used[at] = true;

  // 3. A first or last name on its own: one client has it, or it is ambiguous.
  const ambiguous: AmbiguousName[] = [];
  for (let at = 0; at < words.length; at++) {
    const t = words[at]!;
    if (used[at] || !distinctive(t)) continue;
    const owners = byEnd.get(t) ?? [];
    if (owners.length === 1) hit(owners[0]!, 3, at);
    else if (owners.length > 1 && !ambiguous.some((a) => fold(a.word) === t)) {
      ambiguous.push({ word: written(people[owners[0]!]!, t), count: owners.length, names: owners.slice(0, AMBIGUOUS_NAMES_SHOWN).map((i) => people[i]!.name) });
    }
  }

  const ordered = [...hits.entries()].sort((a, b) => a[1].rank - b[1].rank || a[1].at - b[1].at).map(([i]) => people[i]!.id);
  const all = pinned ? [pinned, ...ordered.filter((id) => id !== pinned)] : ordered;
  return { matched: all.slice(0, MAX_MATCHED), ambiguous, more: Math.max(0, all.length - MAX_MATCHED) };
}
