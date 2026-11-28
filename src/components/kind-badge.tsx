import { Badge, type Tone } from '@/components/ui';
import { KIND_META, type AccountLabel, type KindTone } from '@/lib/credit/account-kind';

const TONE: Record<KindTone, Tone> = { bad: 'bad', ok: 'ok', neutral: 'neutral' };

/** What an account is (src/lib/credit/account-kind.ts): red for negative, green for nothing negative, grey for not labelled. An AI suggestion says so. */
export function KindBadge({ label }: { label: AccountLabel }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge tone={TONE[KIND_META[label.kind].tone]}>{KIND_META[label.kind].label}</Badge>
      {label.by === 'ai' && <Badge tone="info">AI suggestion</Badge>}
    </span>
  );
}
