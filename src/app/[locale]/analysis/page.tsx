import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { Shell } from "@/components/shell";
import { analyze, strengthLabel } from "@/lib/analysis/analyzer";
import { writeLetter } from "@/lib/analysis/letters";
import { SAMPLE_REPORTS } from "@/lib/analysis/sample";

const TONE = { strong: "bg-emerald-100 text-emerald-700", moderate: "bg-amber-100 text-amber-700", weak: "bg-slate-100 text-slate-600" };

export default async function Analysis({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ lang?: string }> }) {
  const { locale } = await params;
  const { lang } = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("analysis");
  const letterLang = lang === "es" ? "es" : lang === "en" ? "en" : locale === "es" ? "es" : "en";
  const findings = analyze(SAMPLE_REPORTS);
  const sender = { name: "Jordan Rivera", address: "123 Main St, Austin, TX 78701" };
  const now = new Date();

  return (
    <Shell locale={locale} active="analysis">
      <div className="no-print flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">{t("title")}</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">{t("subtitle")}</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-slate-500">{t("language")}</span>
          <Link href="/analysis?lang=en" className={letterLang === "en" ? "btn-primary" : "btn-ghost"}>EN</Link>
          <Link href="/analysis?lang=es" className={letterLang === "es" ? "btn-primary" : "btn-ghost"}>ES</Link>
        </div>
      </div>

      <div className="mt-6 space-y-5">
        {findings.map((f) => {
          const label = strengthLabel(f.strength);
          return (
            <article key={f.id} className="card letter overflow-hidden">
              <div className="no-print flex items-start justify-between gap-4 border-b bg-white/60 p-5">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-bold">{f.creditor}</h2>
                    <span className={`chip ${TONE[label]}`}>{t(label)} · {f.strength}</span>
                  </div>
                  <p className="mt-1 font-medium text-slate-700">{f.title}</p>
                  <p className="text-sm text-slate-500">{f.detail}</p>
                  <ul className="mt-2 space-y-0.5 font-mono text-xs text-slate-500">
                    {f.evidence.map((e) => <li key={e}>• {e}</li>)}
                  </ul>
                </div>
                <div className="hidden h-2 w-28 shrink-0 overflow-hidden rounded-full bg-slate-100 sm:block">
                  <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-fuchsia-500" style={{ width: `${f.strength}%` }} />
                </div>
              </div>
              <details className="p-5 print:block" open={false}>
                <summary className="no-print cursor-pointer text-sm font-semibold text-indigo-700">{t("letter")}</summary>
                <pre className="mt-3 whitespace-pre-wrap rounded-xl bg-white p-5 font-serif text-[13px] leading-relaxed text-slate-800 ring-1 ring-slate-200">
                  {writeLetter(f, sender, letterLang, now)}
                </pre>
              </details>
            </article>
          );
        })}
      </div>
      <p className="no-print mt-6 text-xs text-slate-500">{t("noPromise")}</p>
    </Shell>
  );
}
