import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  return (
    <main className="mx-auto max-w-2xl p-10">
      <h1 className="text-3xl font-bold">{t("app.name")}</h1>
      <p className="mt-2 text-slate-600">{t("app.tagline")}</p>
      <div className="mt-6 flex gap-3">
        <Link href="/login" className="rounded-lg bg-brand px-4 py-2 font-semibold text-white">
          {t("auth.submit")}
        </Link>
        <Link href="/" locale={locale === "en" ? "es" : "en"} className="rounded-lg border px-4 py-2">
          {locale === "en" ? "Español" : "English"}
        </Link>
      </div>
      <p className="mt-10 text-xs text-slate-500">{t("compliance.disclaimer")}</p>
    </main>
  );
}
