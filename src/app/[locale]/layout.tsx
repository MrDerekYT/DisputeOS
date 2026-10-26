import "../globals.css";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { locales, type Locale } from "@/i18n/config";
import { SEO, SITE_URL } from "@/lib/site";

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const s = SEO[locale === "es" ? "es" : "en"];
  return {
    metadataBase: new URL(SITE_URL),
    title: { default: s.title, template: "%s · DisputeOS" },
    description: s.description,
    applicationName: "DisputeOS",
    alternates: { canonical: `/${locale}`, languages: { en: "/en", es: "/es" } },
    openGraph: { type: "website", siteName: "DisputeOS", title: s.title, description: s.description, locale: locale === "es" ? "es_US" : "en_US", url: `/${locale}` },
    twitter: { card: "summary_large_image", title: s.title, description: s.description },
    // App pages hold client data; only the home page opts back in.
    robots: { index: false, follow: false },
    themeColor: "#4f46e5",
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!locales.includes(locale as Locale)) notFound();
  setRequestLocale(locale);
  const messages = await getMessages();
  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
