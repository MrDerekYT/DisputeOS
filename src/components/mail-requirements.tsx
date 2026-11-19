import type { Agency } from '@/lib/credit/agencies';
import { fmtDate } from '@/lib/util';

/**
 * What a specialty agency says a mailed dispute must carry, quoted from its own page with the page and the day it was
 * read. Where no page was read, only the link to the agency's instructions is shown: nothing is paraphrased from memory.
 */
export function MailRequirements({ agency, className = '' }: { agency: Agency; className?: string }) {
  const m = agency.mailRequirements;
  const instructions = agency.onlineDisputeUrl ?? agency.disclosure.url;
  if (!m) {
    return <p className={`text-sm text-muted ${className}`}>{agency.shortName} may ask for identity documents or its own form with a mailed dispute. <a className="link" href={instructions} target="_blank" rel="noreferrer">Read its current instructions</a>.</p>;
  }
  return (
    <div className={`rounded-xl bg-raised p-3.5 text-sm ${className}`}>
      <p className="font-medium">What {agency.shortName} asks for by mail</p>
      <p className="mt-1 leading-relaxed text-muted">{m.text}</p>
      {agency.letterNeeds.length > 0 && <p className="mt-2 leading-relaxed text-muted">The letter has a marked line for the details it must state. A person fills them in before the letter can be approved.</p>}
      <p className="mt-2 text-[0.8125rem] text-muted">Read on <a className="link" href={m.sourceUrl} target="_blank" rel="noreferrer">{new URL(m.sourceUrl).hostname}</a> on {fmtDate(m.verifiedOn)}. <a className="link" href={instructions} target="_blank" rel="noreferrer">Check its current instructions</a>.</p>
    </div>
  );
}
