import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { Shell } from "@/components/shell";
import { DEMO_CLIENTS } from "@/lib/demo";
import { ReplyTool, UpdateTool } from "./tools";

export default async function CopilotPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("copilot");
  return (
    <Shell locale={locale} active="copilot">
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-slate-900 via-indigo-800 to-fuchsia-700 p-7 text-white shadow-xl shadow-indigo-500/30">
        <div className="shine absolute inset-0" />
        <span className="chip relative bg-white/15 text-white">{t("badge")}</span>
        <h1 className="relative mt-3 text-3xl font-extrabold tracking-tight">{t("title")}</h1>
        <p className="relative mt-1 max-w-2xl text-indigo-100">{t("sub")}</p>
      </div>
      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <ReplyTool lang={locale} />
        <UpdateTool clients={DEMO_CLIENTS.map((c) => ({ id: c.id, name: c.name }))} />
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        {([["/clients/import#invite", "toolInvite"], ["/clients/import", "toolImport"], ["/analysis", "toolAnalyze"]] as const).map(([h, k]) => (
          <Link key={k} href={h} className="card p-5 text-sm font-semibold text-indigo-700 transition hover:-translate-y-0.5">{t(k)} →</Link>
        ))}
      </div>
    </Shell>
  );
}
