import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import './globals.css';
import { PRODUCT } from '@/lib/product';

export const metadata: Metadata = {
  title: { default: `${PRODUCT.name} — ${PRODUCT.tagline}`, template: `%s · ${PRODUCT.name}` },
  applicationName: PRODUCT.name,
  description: PRODUCT.description,
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#f7f5f0' }, { media: '(prefers-color-scheme: dark)', color: '#0e1116' }],
};

// Runs before first paint so there is no light/dark flash. Allowed by the CSP via the per-request nonce.
const THEME_BOOT = `try{var t=localStorage.getItem('dos-theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t}catch(e){}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:shadow-pop">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
