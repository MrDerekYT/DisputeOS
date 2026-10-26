import Link from 'next/link';
import { BUREAUS } from '@/lib/disputes';

export default function Dashboard() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <ul className="list-disc pl-6">
        {BUREAUS.map((b) => (
          <li key={b} className="capitalize">
            {b}
          </li>
        ))}
      </ul>
      <Link className="underline" href="/dashboard/disputes">
        Manage disputes
      </Link>
    </div>
  );
}
