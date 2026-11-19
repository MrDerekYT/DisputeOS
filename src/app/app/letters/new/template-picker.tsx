import { Badge } from '@/components/ui';
import { LETTER_LIBRARY, LIBRARY_GROUPS } from '@/lib/letters/library';

/** What the file says about the linked dispute: the letter that fits it (if one does right now) and the one-line reason. */
export interface PickerAdvice { value: string | null; item: string; reason: string; missing: string[] }

/**
 * The letter library as a picker: one situation per row, grouped by who the letter goes to, each with a one-line
 * "use when". Plain radio buttons, so it works without scripting and posts `templateKey` like the select it replaced.
 * With a dispute linked, the letter recommended for it is marked and the reason is given above the list; every other
 * letter that fits the dispute stays one click away, and one that does not fit is greyed out with the reason.
 */
export function TemplatePicker({ selected, own, advice, unavailable = {} }: {
  selected: string; own: { id: string; name: string }[]; advice?: PickerAdvice;
  /** Letters that cannot be drafted for the linked dispute, by value, each with the reason. They stay visible, greyed out. */
  unavailable?: Record<string, string>;
}) {
  const groups = [
    ...LIBRARY_GROUPS.map((g) => ({ label: g.label, items: LETTER_LIBRARY.filter((e) => e.group === g.key).map((e) => ({ value: e.templateKey, name: e.name, useWhen: e.useWhen })) })),
    ...(own.length ? [{ label: 'Your own templates', items: own.map((t) => ({ value: `org:${t.id}`, name: t.name, useWhen: 'Your agency’s own wording.' })) }] : []),
  ];
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
      {groups.map((g) => {
        // A whole group ruled out for one reason (the dispute goes to someone else) is said once, not on every row.
        const reasons = new Set(g.items.map((i) => unavailable[i.value] ?? ''));
        const whole = reasons.size === 1 && !reasons.has('') ? [...reasons][0]! : null;
        return (
          <fieldset key={g.label}>
            <legend className="mb-1.5 text-[0.8125rem] font-medium text-muted">{g.label}</legend>
            {whole ? <p className="rounded-xl border border-line px-3.5 py-2.5 text-[0.8125rem] text-muted" data-unavailable="">Not for this dispute. {whole}</p> : (
              <div className="divide-y divide-line/70 rounded-xl border border-line">
                {g.items.map((i) => {
                  const no = unavailable[i.value];
                  return (
                    <label key={i.value} data-unavailable={no ? '' : undefined}
                      className={`flex items-start gap-3 px-3.5 py-2.5 text-sm transition-colors first:rounded-t-xl last:rounded-b-xl ${no ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-raised has-[:checked]:bg-raised'}`}>
                      <input type="radio" name="templateKey" value={i.value} defaultChecked={!no && i.value === selected} disabled={!!no} required className="mt-1 shrink-0 accent-[rgb(var(--brand))]" />
                      <span className="min-w-0"><span className={`font-medium ${no ? 'text-muted' : ''}`}>{i.name}</span>{advice?.value === i.value && <span className="ml-2"><Badge tone="brand">Recommended</Badge></span>}
                        <span className="block text-[0.8125rem] text-muted">{no ? `Not for this dispute. ${no}` : i.useWhen}</span></span>
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>
        );
      })}
    </div>
  );
}
