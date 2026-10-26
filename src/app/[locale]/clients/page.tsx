import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { Shell } from "@/components/shell";
import { DEMO_CLIENTS, STAGES, initials, summarize } from "@/lib/demo";

const STAGE_TONE = {
  intake: "from-slate-400 to-slate-500",
  analysis: "from-blue-500 to-indigo-500",
  disputing: "from-violet-500 to-fuchsia-500",
  monitoring: "from-emerald-500 to-teal-500",
} as const;

export default async function Roster({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("crm");
  const sums = DEMO_CLIENTS.map(summarize);
  const gains = DEMO_CLIENTS.map((c, i) => sums[i]!.gain).filter((g) => g > 0);
  const stats = [
    [t("active"), String(DEMO_CLIENTS.length), "from-indigo-500 to-blue-500"],
    [t("avgGain"), `+${Math.round(gains.reduce((a, b) => a + b, 0) / (gains.length || 1))}`, "from-emerald-500 to-teal-500"],
    [t("removed"), String(sums.reduce((a, s) => a + s.removed, 0)), "from-violet-500 to-fuchsia-500"],
    [t("needsYou"), String(DEMO_CLIENTS.filter((c) => c.nextAction === "reviewFindings" || c.nextAction === "approveLetters").length), "from-amber-500 to-orange-500"],
  ];

  return (
    <Shell locale={locale} active="clients">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">{t("rosterTitle")}</h1>
          <p className="mt-1 text-sm text-slate-600">{t("rosterSub")}</p>
        </div>
        <div className="flex gap-2">
          <Link href="/clients/import" className="btn-ghost">{t("import")}</Link>
          <Link href="/clients/import#invite" className="btn-primary">{t("invite")}</Link>
        </div>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(([label, value, g]) => (
          <div key={label} className="card relative overflow-hidden p-5">
            <div className={`absolute -right-6 -top-6 h-20 w-20 rounded-full bg-gradient-to-br ${g} opacity-20`} />
            <div className="text-sm text-slate-500">{label}</div>
            <div className="mt-1 text-3xl font-extrabold">{value}</div>
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-4">
        {STAGES.map((stage) => {
          const list = DEMO_CLIENTS.filter((c) => c.stage === stage);
          return (
            <section key={stage} className="rounded-2xl bg-slate-100/70 p-3">
              <header className="mb-3 flex items-center justify-between px-1">
                <span className="flex items-center gap-2 text-sm font-bold">
                  <span className={`h-2.5 w-2.5 rounded-full bg-gradient-to-br ${STAGE_TONE[stage]}`} />
                  {t(`s_${stage}`)}
                </span>
                <span className="chip bg-white text-slate-600">{list.length}</span>
              </header>
              <div className="space-y-3">
                {list.map((c) => {
                  const s = summarize(c);
                  return (
                    <Link key={c.id} href={`/clients/${c.id}`} className="card block p-4">
                      <div className="flex items-center gap-3">
                        <span className={`grid h-10 w-10 place-items-center rounded-full bg-gradient-to-br ${STAGE_TONE[stage]} text-sm font-bold text-white`}>{initials(c.name)}</span>
                        <div className="min-w-0">
                          <div className="truncate font-semibold">{c.name}</div>
                          <div className="text-xs text-slate-500">{c.lang.toUpperCase()} · {t("day")} {c.daysIn}</div>
                        </div>
                        {s.gain > 0 && <span className="chip ml-auto bg-emerald-100 text-emerald-700">+{s.gain}</span>}
                      </div>
                      {s.total > 0 && (
                        <div className="mt-3">
                          <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                            <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-fuchsia-500" style={{ width: `${s.pct}%` }} />
                          </div>
                          <div className="mt-1 text-xs text-slate-500">{s.removed}/{s.total} {t("removedLower")}</div>
                        </div>
                      )}
                      <div className="mt-3 rounded-lg bg-indigo-50 px-2.5 py-1.5 text-xs font-medium text-indigo-700">→ {t(`na_${c.nextAction}`)}</div>
                    </Link>
                  );
                })}
                {list.length === 0 && <p className="px-2 py-6 text-center text-xs text-slate-400">—</p>}
              </div>
            </section>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-slate-500">{t("demoNote")}</p>
    </Shell>
  );
}
