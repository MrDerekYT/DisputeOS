import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { Ring, ScoreChart } from "@/components/art";
import { getClient, STATUS_TONE, summarize } from "@/lib/demo";
import { verifyPortal, signPortal } from "@/lib/access";

export default async function Portal({ params }: { params: Promise<{ locale: string; token: string }> }) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  const id = verifyPortal(decodeURIComponent(token));
  const c = id ? getClient(id) : undefined;
  if (!c) notFound();
  const t = await getTranslations("crm");
  const s = summarize(c);
  const months = locale === "es" ? ["Ene", "Feb", "Mar", "Abr", "May", "Jun"] : ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];
  const points = c.history.map((v, i) => ({ label: months[i % 6]!, value: v }));
  const steps = ["intake", "analysis", "disputing", "monitoring"] as const;
  const at = steps.indexOf(c.stage);

  return (
    <main className="mx-auto max-w-4xl px-5 py-8">
      <header className="flex items-center justify-between">
        <span className="flex items-center gap-2.5 text-lg font-extrabold">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-lg shadow-indigo-500/30">D</span>
          DisputeOS
        </span>
        <div className="flex gap-2">
          <Link href={`/portal/${signPortal(c.id)}`} locale={locale === "en" ? "es" : "en"} className="btn-ghost">{locale === "en" ? "Español" : "English"}</Link>
        </div>
      </header>

      <section className="relative mt-6 overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-700 via-violet-700 to-fuchsia-600 p-7 text-white shadow-xl shadow-indigo-500/30">
        <div className="shine absolute inset-0" />
        <div className="relative flex flex-wrap items-center justify-between gap-6">
          <div>
            <p className="text-indigo-100">{t("hello")}</p>
            <h1 className="text-3xl font-extrabold tracking-tight">{c.name.split(" ")[0]} 👋</h1>
            <p className="mt-2 max-w-md text-sm text-indigo-100">{t("portalSub")}</p>
          </div>
          {c.score > 0 && (
            <div className="rounded-2xl bg-white/15 px-6 py-4 text-center backdrop-blur">
              <div className="text-xs uppercase tracking-wide text-indigo-100">{t("yourScore")}</div>
              <div className="text-5xl font-black">{c.score}</div>
              {s.gain > 0 && <div className="mt-1 text-sm font-semibold text-emerald-200">▲ {s.gain} {t("points")}</div>}
            </div>
          )}
        </div>
      </section>

      <nav aria-label={t("journey")} className="card mt-4 p-5">
        <ol className="grid grid-cols-4 gap-2 text-center text-xs font-semibold sm:text-sm">
          {steps.map((k, i) => (
            <li key={k}>
              <div className={`mx-auto grid h-9 w-9 place-items-center rounded-full font-bold ${i < at ? "bg-emerald-500 text-white" : i === at ? "bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-lg shadow-indigo-500/30" : "bg-slate-100 text-slate-400"}`}>{i < at ? "✓" : i + 1}</div>
              <div className={`mt-2 ${i <= at ? "text-slate-900" : "text-slate-400"}`}>{t(`p_${k}`)}</div>
            </li>
          ))}
        </ol>
      </nav>

      {c.clientTasks.length > 0 && (
        <section className="card mt-4 border-amber-200 bg-amber-50/80 p-5">
          <h2 className="font-bold text-amber-900">{t("whatWeNeed")}</h2>
          <ul className="mt-3 space-y-2">
            {c.clientTasks.map((k) => (
              <li key={k} className="flex items-center justify-between gap-3 rounded-xl bg-white p-3 text-sm shadow-sm">
                <span className="font-medium">{t(`task_${k}`)}</span>
                <span className="chip bg-amber-100 text-amber-800">{t("todo")}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-4 grid gap-4 md:grid-cols-5">
        <section className="card p-5 md:col-span-3">
          <h2 className="font-bold">{t("whatsHappening")}</h2>
          {c.items.length === 0 ? <p className="py-6 text-center text-sm text-slate-400">{t("portalNoItems")}</p> : (
            <ul className="mt-3 divide-y">
              {c.items.map((i) => (
                <li key={i.creditor + i.bureau} className="flex items-center justify-between gap-2 py-3">
                  <div>
                    <div className="font-semibold">{i.creditor}</div>
                    <div className="text-xs text-slate-500">{t(`issue_${i.issue}`)}</div>
                  </div>
                  <span className={`chip ${STATUS_TONE[i.status]}`}>{t(`st_${i.status}`)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card flex flex-col items-center justify-center p-5 md:col-span-2">
          <h2 className="mb-2 font-bold">{t("progress")}</h2>
          <Ring value={s.pct} label={t("progress")} />
          <p className="mt-2 text-xs text-slate-500">{s.removed}/{s.total} {t("removedLower")}</p>
        </section>
      </div>

      {points.length > 1 && (
        <section className="card mt-4 p-5">
          <h2 className="font-bold">{t("scoreHistory")}</h2>
          <ScoreChart points={points} />
        </section>
      )}

      <section className="card mt-4 p-5">
        <h2 className="font-bold">{t("helpTitle")}</h2>
        <p className="mt-1 text-sm text-slate-600">{t("helpBody")}</p>
      </section>
      <p className="mt-6 text-xs text-slate-500">{t("portalDisclaimer")}</p>
    </main>
  );
}
