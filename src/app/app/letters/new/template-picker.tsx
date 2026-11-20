import { Badge } from '@/components/ui';
import { LETTER_LIBRARY, LIBRARY_GROUPS } from '@/lib/letters/library';

/** What the file says about the linked dispute: the letter that fits it (if one does right now) and the one-line reason. */
export interface PickerAdvice { value: string | null; item: string; reason: string; missing: string[] }

/**
 * The letter library as a picker: one situation per row, grouped by who the letter goes to, each with a one-line
 * "use when". Plain radio buttons, so it works without scripting and posts `templateKey` like the select it replaced.
 * With a dispute linked, the letter recommended for it is marked and the reason is given above the list. Only letters
 * that can be drafted are rows; the ones that do not fit are folded away under each group ("3 more that do not fit this
 * dispute"), each with its reason, so the list stays short and nothing is hidden without saying why.
 */
export function TemplatePicker({ selected, own, advice, unavailable = {} }: {
  selected: string; own: { id: string; name: string }[]; advice?: PickerAdvice;
  /** Letters that cannot be drafted for the linked dispute, by value, each with the reason. */
  unavailable?: Record<string, string>;
}) {
  const groups = [
    ...LIBRARY_GROUPS.map((g) => ({ label: g.label, items: LETTER_LIBRARY.filter((e) => e.group === g.key).map((e) => ({ value: e.templateKey, name: e.name, useWhen: e.useWhen })) })),
    ...(own.length ? [{ label: 'Your own templates', items: own.map((t) => ({ value: `org:${t.id}`, name: t.name, useWhen: 'Your agency’s own wording.' })) }] : []),
  ].map((g) => ({ ...g, fits: g.items.filter((i) => !unavailable[i.value]), out: g.items.filter((i) => unavailable[i.value]) }));
  const SUMMARY = 'w-fit cursor-pointer rounded-md text-[0.8125rem] text-muted hover:text-ink';
  // Whole groups with nothing to draft (the dispute goes to someone else) are named in one line at the end.
  const ruledOut = groups.filter((g) => g.fits.length === 0);
  return (
    <div className="space-y-4">
      <div>
        <div className="label">Letter</div>
        <p className="text-[0.8125rem] text-muted">Choose the situation. Every letter is written in English and drafted from what is on file for the client.</p>
        {advice && (
          <p className="mt-2 rounded-xl bg-raised px-3.5 py-2.5 text-[0.8125rem]">
            <span className="font-medium">{advice.value ? 'Recommended' : 'No letter is recommended right now'} for {advice.item}.</span> {advice.reason}
            {advice.missing.length > 0 && <span className="text-warn"> {advice.missing.join(' ')}</span>}
          </p>
        )}
      </div>
      {groups.filter((g) => g.fits.length > 0).map((g) => (
        <fieldset key={g.label}>
          <legend className="mb-1.5 text-[0.8125rem] font-medium text-muted">{g.label}</legend>
          <div className="divide-y divide-line/70 rounded-xl border border-line">
            {g.fits.map((i) => (
              <label key={i.value} className="flex cursor-pointer items-start gap-3 px-3.5 py-2.5 text-sm transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-raised has-[:checked]:bg-raised">
                <input type="radio" name="templateKey" value={i.value} defaultChecked={i.value === selected} required className="mt-1 shrink-0 accent-[rgb(var(--brand))]" />
                <span className="min-w-0"><span className="font-medium">{i.name}</span>{advice?.value === i.value && <span className="ml-2"><Badge tone="brand">Recommended</Badge></span>}
                  <span className="block text-[0.8125rem] text-muted">{i.useWhen}</span></span>
              </label>
            ))}
          </div>
          {g.out.length > 0 && (
            <details className="mt-2">
              <summary className={SUMMARY}>{g.out.length} more that {g.out.length === 1 ? 'does' : 'do'} not fit this dispute</summary>
              <ul className="mt-2 space-y-1.5 text-[0.8125rem] text-muted">
                {g.out.map((i) => <li key={i.value} data-unavailable=""><span className="font-medium text-ink">{i.name}.</span> {unavailable[i.value]}</li>)}
              </ul>
            </details>
          )}
        </fieldset>
      ))}
      {ruledOut.length > 0 && (
        <details>
          <summary className={SUMMARY}>Not for this dispute: letters {ruledOut.map((g) => g.label.replace(/^To /, 'to ')).join(', ')}</summary>
          <ul className="mt-2 space-y-1.5 text-[0.8125rem] text-muted">
            {ruledOut.map((g) => {
              // One reason for the whole group (the dispute goes to someone else) is said once, not for every letter.
              const reasons = [...new Set(g.out.map((i) => unavailable[i.value]!))];
              return reasons.length === 1
                ? <li key={g.label} data-unavailable=""><span className="font-medium text-ink">{g.label}.</span> {reasons[0]}</li>
                : g.out.map((i) => <li key={i.value} data-unavailable=""><span className="font-medium text-ink">{i.name}.</span> {unavailable[i.value]}</li>);
            })}
          </ul>
        </details>
      )}
    </div>
  );
}
