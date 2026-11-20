import { Badge, type Tone } from '@/components/ui';
import type { OverlapLevel, WordingOverlap } from '@/lib/letters/overlap';

const LEVEL: Record<OverlapLevel, { label: string; tone: Tone; says: string }> = {
  low: { label: 'Low', tone: 'ok', says: 'Most of this letter is in wording of its own.' },
  medium: { label: 'Medium', tone: 'neutral', says: 'Part of this letter is word for word in a recent letter for another client, usually the standard request and enclosure lines.' },
  high: { label: 'High', tone: 'warn', says: 'Most of this letter is word for word in a recent letter for another client: the standard paragraphs are the same in every letter of this kind. What sets it apart is the reason and the documents, so check that the reason states this client’s own facts.' },
};

/**
 * How much of this letter also appears in the agency's other recent letters (src/lib/letters/overlap.ts): the whole
 * letter is compared, standard paragraphs included, with this client's names, numbers and reason left out. A
 * word-overlap count done on the server from letter text: no AI, and nothing is sent anywhere. Nothing is shown when
 * there is no other letter to compare with.
 */
export function WordingOverlapNote({ overlap }: { overlap: WordingOverlap | null }) {
  if (!overlap) return null;
  const l = LEVEL[overlap.level];
  return (
    <div className="mb-4 border-b border-line pb-4 text-sm" data-wording-overlap={overlap.level}>
      <p className="flex flex-wrap items-center gap-2">Wording overlap with other recent letters: <Badge tone={l.tone}>{l.label}</Badge></p>
      <p className="mt-1.5 text-xs text-muted">
        {l.says} About {Math.round(overlap.score * 100)}% of its wording is in the closest one. Compared with {overlap.compared} recent {overlap.compared === 1 ? 'letter' : 'letters'} for other clients, here and without AI. The whole letter is counted, standard paragraphs included; names, numbers, the reason and the enclosure list are left out.
      </p>
    </div>
  );
}
