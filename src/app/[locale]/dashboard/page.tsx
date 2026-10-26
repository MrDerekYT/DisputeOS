import { getTranslations, setRequestLocale } from "next-intl/server";
import { Shell } from "@/components/shell";
import { Ring, ScoreChart } from "@/components/art";
import { analyze } from "@/lib/analysis/analyzer";
import { SAMPLE_REPORTS } from "@/lib/analysis/sample";

const SCORE = [
  { label: "May", value: 548 }, { label: "Jun", value: 561 }, { label: "Jul", value: 570 },
  { label: "Aug", value: 589 }, { label: "Sep", value: 604 }, { label: "Oct", value: 612 },
];

export default async function Dashboard({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("dash");
  const findings = analyze(SAMPLE_REPORTS).slice(0, 4);
  const stats = [
    [t("open"), "7", "from-indigo-500 to-blue-500"],
    [t("wins"), "3", "from-emerald-500 to-teal-500"],
    [t("spend"), "$41.20", "from-violet-500 to-fuchsia-500"],
    [t("perDeletion"), "$13.73", "from-amber-500 to-orange-500"],
  ];
  return (
    <Shell locale={locale} active="dashboard">
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-700 via-violet-700 to-fuchsia-600 p-7 text-white shadow-xl shadow-indigo-500/30">
        <div className="shine absolute inset-0" />
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight">{t("title")}</h1>
            <p className="mt-1 text-indigo-100">Score 612 · up 64 points in 6 months</p>
          </div>
          <span className="chip bg-white/20 text-white backdrop-blur">{t("demo")}</span>
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

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <section className="card p-5 lg:col-span-2">
          <h2 className="font-bold">{t("scoreHistory")}</h2>
          <ScoreChart points={SCORE} />
        </section>
        <section className="card flex flex-col items-center justify-center p-5">
          <h2 className="mb-2 font-bold">{t("resolution")}</h2>
          <Ring value={60} label={t("resolution")} />
          <p className="mt-2 text-center text-xs text-slate-500">3 of 5 closed items resolved</p>
        </section>
      </div>

      <section className="card mt-4 p-5">
        <h2 className="font-bold">{t("next")}</h2>
        <ul className="mt-3 divide-y">
          {findings.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-3 py-3">
              <div>
                <div className="font-semibold">{f.creditor}</div>
                <div className="text-sm text-slate-500">{f.title}</div>
              </div>
              <span className={`chip ${f.strength >= 80 ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{f.strength}</span>
            </li>
          ))}
        </ul>
      </section>
    </Shell>
  );
}
