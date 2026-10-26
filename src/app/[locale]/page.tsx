import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { HeroArt } from "@/components/art";

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="flex items-center justify-between">
        <span className="flex items-center gap-2.5 text-lg font-extrabold">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-lg shadow-indigo-500/30">D</span>
          {t("app.name")}
        </span>
        <div className="flex items-center gap-2">
          <Link href="/" locale={locale === "en" ? "es" : "en"} className="btn-ghost">{locale === "en" ? "Español" : "English"}</Link>
          <Link href="/login" className="btn-ghost">{t("auth.submit")}</Link>
        </div>
      </header>

      <section className="mt-12 grid items-center gap-10 md:grid-cols-2">
        <div>
          <span className="chip bg-indigo-100 text-indigo-700">{t("home.eyebrow")}</span>
          <h1 className="mt-4 text-4xl font-extrabold leading-tight tracking-tight md:text-5xl">
            <span className="gradient-text">{t("home.headline")}</span>
          </h1>
          <p className="mt-4 max-w-lg text-lg text-slate-600">{t("home.sub")}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/dashboard" className="btn-primary px-6 py-3">{t("home.cta")}</Link>
            <Link href="/analysis" className="btn-ghost px-6 py-3">{t("home.cta2")}</Link>
          </div>
          <div className="mt-8 flex flex-wrap gap-2 text-xs font-semibold text-slate-600">
            {["FCRA", "FDCPA", "CROA", "EN / ES", "MFA"].map((b) => <span key={b} className="rounded-full border bg-white/70 px-3 py-1">{b}</span>)}
          </div>
        </div>
        <HeroArt className="w-full" />
      </section>
      <p className="mt-16 text-xs text-slate-500">{t("compliance.disclaimer")}</p>
    </main>
  );
}
