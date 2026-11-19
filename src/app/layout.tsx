import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import localFont from 'next/font/local';
import './globals.css';
import { PRODUCT } from '@/lib/product';

// Self-hosted variable fonts (latin subset, which covers English and Spanish). Local files mean the build needs no
// network and the strict CSP (font-src 'self') needs no exception. Other scripts fall back to the system stack.
const instrument = localFont({
  src: [
    { path: './fonts/InstrumentSans-latin-var.woff2', weight: '400 700', style: 'normal' },
    { path: './fonts/InstrumentSans-Italic-latin-var.woff2', weight: '400 700', style: 'italic' },
  ],
  variable: '--font-instrument', display: 'swap',
  fallback: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
});
const bricolage = localFont({
  src: [{ path: './fonts/BricolageGrotesque-latin-var.woff2', weight: '400 700', style: 'normal' }],
  variable: '--font-bricolage', display: 'swap',
  fallback: ['Segoe UI Variable Display', 'Segoe UI', 'system-ui', '-apple-system', 'sans-serif'],
});

export const metadata: Metadata = {
  title: { default: `${PRODUCT.name} — ${PRODUCT.tagline}`, template: `%s · ${PRODUCT.name}` },
  applicationName: PRODUCT.name,
  description: PRODUCT.description,
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0F1433',
};

// Dark is the default: the server renders data-theme="dark" and the CSS defaults to the dark tokens. This runs before
// first paint and switches to light only for someone who chose it with the theme toggle, so there is no flash.
// Allowed by the CSP via the per-request nonce.
const THEME_BOOT = `try{if(localStorage.getItem('dos-theme')==='light')document.documentElement.dataset.theme='light'}catch(e){}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en" data-theme="dark" className={`${instrument.variable} ${bricolage.variable}`} suppressHydrationWarning>
      <head>
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:font-semibold focus:text-ink focus:shadow-pop">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
