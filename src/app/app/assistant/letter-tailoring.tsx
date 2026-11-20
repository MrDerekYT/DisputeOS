import { AI_COSTS } from '@/lib/ai/credits';
import { setLetterAutoTailorAction } from '../letters/tailor-actions';

/**
 * The agency's one optional setting for letter wording, shown to owners and admins beside the other AI spending
 * switch. Off by default. On, every drafted letter goes through the same AI wording step as the button on the letter;
 * either way a letter stays a draft until a person approves it.
 */
export function LetterTailoringSetting({ on }: { on: boolean }) {
  const cost = AI_COSTS.letter_suggestion;
  return (
    <div className="mt-5 border-t border-line pt-4" id="letter-wording">
      <h3 className="mb-1 text-sm font-semibold">Tailor wording automatically when a letter is drafted: {on ? 'on' : 'off'}</h3>
      <p className="mb-2 text-sm text-muted">{on
        ? `Each new draft goes through the AI wording step once: ${cost} credits when a reworded version passes every check, nothing otherwise. Only the standard salutation, linking sentence, closing lines and sign-off can change; every other line of the letter is locked. The salutation and the sign-off have to come from a short fixed list, and the reworded linking and closing lines are checked against a list of courtesy words. The result is saved as a new draft version marked “AI wording”, and a person still reads and approves it before anything is mailed.`
        : 'New drafts use the standard wording, which already follows each client’s file. “Suggest better wording” stays a button on every letter, and nothing is charged until someone presses it.'}</p>
      <form action={setLetterAutoTailorAction}><input type="hidden" name="on" value={on ? 'false' : 'true'} />
        <button type="submit" className="btn-secondary btn-sm">{on ? 'Turn off automatic wording' : `Turn on (${cost} credits per drafted letter)`}</button></form>
    </div>
  );
}
