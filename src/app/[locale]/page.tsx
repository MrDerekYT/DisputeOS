import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { HeroArt } from "@/components/art";
import type { Metadata } from "next";
import { SEO, SITE_URL } from "@/lib/site";

export const metadata: Metadata = { robots: { index: true, follow: true } };

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations();
  const seo = SEO[locale === "es" ? "es" : "en"];
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "DisputeOS",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    inLanguage: ["en", "es"],
    description: seo.description,
    url: `${SITE_URL}/${locale}`,
  };
  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
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
            <Link href="/clients" className="btn-primary px-6 py-3">{t("home.cta")}</Link>
            <Link href="/portal/jordan-rivera" className="btn-ghost px-6 py-3">{t("crm.viewPortal")}</Link>
            <Link href="/analysis" className="btn-ghost px-6 py-3">{t("home.cta2")}</Link>
          </div>
          <div className="mt-8 flex flex-wrap gap-2 text-xs font-semibold text-slate-600">
            {["FCRA", "FDCPA", "CROA", "EN / ES", "MFA"].map((b) => <span key={b} className="rounded-full border bg-white/70 px-3 py-1">{b}</span>)}
          </div>
        </div>
        <div className="glow"><HeroArt className="w-full" /></div>
      </section>
      <section className="mt-16 grid gap-4 md:grid-cols-3">
        {[
          ["01", "Import & review", "Parse bureau reports, see confidence on every field.", "from-indigo-500 to-blue-500"],
          ["02", "Analyze & draft", "Ranked findings with vetted citations, EN and ES.", "from-violet-500 to-fuchsia-500"],
          ["03", "Approve & mail", "Human approval, certified tracking, no double sends.", "from-emerald-500 to-teal-500"],
        ].map(([n, h, d, g], i) => (
          <div key={n} className="card relative overflow-hidden p-6" style={{ ["--i" as string]: i }}>
            <div className={`absolute -right-8 -top-8 h-28 w-28 rounded-full bg-gradient-to-br ${g} opacity-20`} />
            <div className={`bg-gradient-to-r ${g} bg-clip-text text-3xl font-black text-transparent`}>{n}</div>
            <h3 className="mt-2 text-lg font-bold">{h}</h3>
            <p className="mt-1 text-sm text-slate-600">{d}</p>
          </div>
        ))}
      </section>
      <p className="mt-16 text-xs text-slate-500">{t("compliance.disclaimer")}</p>
    </main>
  );
}
