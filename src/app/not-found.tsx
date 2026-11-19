import Link from 'next/link';
import type { Metadata } from 'next';
import { PlainPage } from '@/components/auth-layout';

export const metadata: Metadata = { title: 'Page not found', robots: { index: false } };

/** Any address that does not exist. The visitor is unknown here, so it offers the two ways back that fit anyone. */
export default function NotFound() {
  return (
    <PlainPage eyebrow="Error 404" title="This page is not here.">
      <p>The address may be mistyped, or the page may have been moved or removed. A link from an older email may also have expired.</p>
      <div className="mt-7 flex flex-wrap gap-2.5">
        <Link href="/login" className="btn-primary">Go to sign in</Link>
        <Link href="/" className="btn-secondary">Home</Link>
      </div>
      <p className="mt-6 text-sm">Here as a client? <Link href="/portal/login" className="link">Client portal sign-in</Link></p>
    </PlainPage>
  );
}
