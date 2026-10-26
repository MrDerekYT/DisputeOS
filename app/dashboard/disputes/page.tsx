import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { daysRemaining } from '@/lib/disputes';

export const dynamic = 'force-dynamic';

export default async function Disputes() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('disputes')
    .select('id,bureau,reason,status,current_round,dispute_rounds(due_at)')
    .order('created_at', { ascending: false });
  if (error) return <p>Sign in and configure Supabase to view disputes.</p>;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Disputes</h1>
      <Link className="underline" href="/dashboard/disputes/new">
        New dispute
      </Link>
      <ul className="divide-y">
        {(data ?? []).map((d) => {
          const due = d.dispute_rounds?.[0]?.due_at;
          return (
            <li key={d.id} className="py-2">
              <span className="capitalize">{d.bureau}</span> — {d.reason} ({d.status}, round{' '}
              {d.current_round}){due && <span> · {daysRemaining(new Date(due))} days left</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
