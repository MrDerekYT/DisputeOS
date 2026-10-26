import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { Shell } from "@/components/shell";
import { Ring, ScoreChart } from "@/components/art";
import { getClient, initials, STATUS_TONE, summarize } from "@/lib/demo";
import { portalHref } from "@/lib/access";

export default async function CasePage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const c = getClient(id);
  if (!c) notFound();
  const t = await getTranslations("crm");
  const s = summarize(c);
  const months = locale === "es" ? ["Ene", "Feb", "Mar", "Abr", "May", "Jun"] : ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];
  const points = c.history.map((v, i) => ({ label: months[i % 6]!, value: v }));
  const timeline = [
    [c.daysIn, "ev_signup"], [Math.max(c.daysIn - 3, 0), "ev_reports"], [Math.max(c.daysIn - 7, 0), "ev_analysis"],
    ...(c.items.some((i) => i.status !== "draft") ? [[Math.max(c.daysIn - 14, 0), "ev_letters"] as const] : []),
    ...(c.items.some((i) => i.status === "removed") ? [[Math.max(c.daysIn - 45, 0), "ev_response"] as const] : []),
  ].sort((a, b) => Number(a[0]) - Number(b[0]));

  return (
    <Shell locale={locale} active="clients">
      <Link href="/clients" className="text-sm font-medium text-indigo-700">← {t("back")}</Link>

      <div className="relative mt-3 overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-700 via-violet-700 to-fuchsia-600 p-7 text-white shadow-xl shadow-indigo-500/30">
        <div className="shine absolute inset-0" />
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <span className="grid h-16 w-16 place-items-center rounded-2xl bg-white/20 text-xl font-extrabold backdrop-blur">{initials(c.name)}</span>
            <div>
              <h1 className="text-3xl font-extrabold tracking-tight">{c.name}</h1>
              <p className="text-indigo-100">{t(`s_${c.stage}`)} · {t("day")} {c.daysIn} · {c.lang.toUpperCase()}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Link href={portalHref(c.id)} className="btn bg-white text-indigo-700 hover:bg-indigo-50">{t("viewPortal")}</Link>
            <Link href="/analysis" className="btn bg-white/15 text-white backdrop-blur hover:bg-white/25">{t("openAnalysis")}</Link>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <section className="card p-5 lg:col-span-2">
          <div className="flex items-baseline justify-between">
            <h2 className="font-bold">{t("scoreHistory")}</h2>
            {s.gain > 0 && <span className="chip bg-emerald-100 text-emerald-700">+{s.gain} {t("points")}</span>}
          </div>
          {points.length > 1 ? <ScoreChart points={points} /> : <p className="py-10 text-center text-sm text-slate-400">{t("noScore")}</p>}
        </section>
        <section className="card flex flex-col items-center justify-center p-5">
          <h2 className="mb-2 font-bold">{t("progress")}</h2>
          <Ring value={s.pct} label={t("progress")} />
          <p className="mt-2 text-xs text-slate-500">{s.removed}/{s.total} {t("removedLower")}</p>
        </section>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <section className="card p-5 lg:col-span-2">
          <h2 className="font-bold">{t("items")}</h2>
          {c.items.length === 0 ? <p className="py-6 text-center text-sm text-slate-400">{t("noItems")}</p> : (
            <ul className="mt-3 divide-y">
              {c.items.map((i) => (
                <li key={i.creditor + i.bureau} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div>
                    <div className="font-semibold">{i.creditor}</div>
                    <div className="text-sm text-slate-500">{t(`issue_${i.issue}`)} · {i.bureau}</div>
                  </div>
                  <span className={`chip ${STATUS_TONE[i.status]}`}>{t(`st_${i.status}`)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <div className="space-y-4">
          <section className="card p-5">
            <h2 className="font-bold">{t("nextStep")}</h2>
            <p className="mt-2 rounded-xl bg-indigo-50 p-3 text-sm font-medium text-indigo-700">→ {t(`na_${c.nextAction}`)}</p>
            {c.clientTasks.length > 0 && (
              <>
                <h3 className="mt-4 text-sm font-semibold text-slate-700">{t("waitingOnClient")}</h3>
                <ul className="mt-1 space-y-1 text-sm text-slate-600">{c.clientTasks.map((k) => <li key={k}>○ {t(`task_${k}`)}</li>)}</ul>
              </>
            )}
          </section>
          <section className="card p-5">
            <h2 className="font-bold">{t("timeline")}</h2>
            <ol className="mt-3 space-y-3 border-l-2 border-indigo-100 pl-4">
              {timeline.map(([d, k]) => (
                <li key={String(k)} className="relative">
                  <span className="absolute -left-[22px] top-1 h-2.5 w-2.5 rounded-full bg-indigo-500 ring-4 ring-white" />
                  <div className="text-sm font-medium">{t(String(k))}</div>
                  <div className="text-xs text-slate-500">{new Date(Date.now() - Number(d) * 86_400_000).toLocaleDateString(locale)}</div>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
      <p className="mt-4 text-xs text-slate-500">{t("demoNote")}</p>
    </Shell>
  );
}
