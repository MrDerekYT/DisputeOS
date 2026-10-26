import Link from 'next/link';

export default function Home() {
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold">DisputeOS</h1>
      <p>Automated dispute management with FCRA/FDCPA-aware workflows and certified mail.</p>
      <Link className="underline" href="/dashboard">
        Open dashboard
      </Link>
    </div>
  );
}
