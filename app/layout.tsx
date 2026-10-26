import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { signOut } from './login/actions';

export const metadata: Metadata = {
  title: 'DisputeOS',
  description: 'Credit repair platform with personal and agency modes.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-slate-900">
        <header className="border-b px-6 py-3 flex gap-6 items-center">
          <Link href="/" className="font-bold">
            DisputeOS
          </Link>
          <Link href="/dashboard">Dashboard</Link>
          <Link href="/dashboard/disputes">Disputes</Link>
          <Link href="/dashboard/import">Import</Link>
          <Link href="/dashboard/letters">Letters</Link>
          <form action={signOut} className="ml-auto">
            <button className="text-sm underline">Sign out</button>
          </form>
        </header>
        <main className="mx-auto max-w-4xl p-6">{children}</main>
        <footer className="p-6 text-xs text-slate-500">
          DisputeOS is software, not legal advice. Use in compliance with the FCRA and FDCPA.
        </footer>
      </body>
    </html>
  );
}
