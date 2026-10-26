import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { Shell } from "@/components/shell";
import { getClient, STATUS_TONE } from "@/lib/demo";
import { DEMO_RESPONSES, decide, followUpLetter } from "@/lib/responses";

const OUTCOME_TONE = {
  deleted: "bg-emerald-100 text-emerald-700",
  verified: "bg-amber-100 text-amber-700",
  updated: "bg-blue-100 text-blue-700",
  noResponse: "bg-rose-100 text-rose-700",
} as const;

export default async function ResponsesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("resp");
  const lang = locale === "es" ? "es" : "en";

  return (
    <Shell locale={locale} active="responses">
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-700 via-violet-700 to-fuchsia-600 p-7 text-white shadow-xl shadow-indigo-500/30">
        <div className="shine absolute inset-0" />
        <h1 className="relative text-3xl font-extrabold tracking-tight">{t("title")}</h1>
        <p className="relative mt-1 max-w-2xl text-indigo-100">{t("sub")}</p>
      </div>

      <ul className="mt-6 space-y-4">
        {DEMO_RESPONSES.map((r) => {
          const d = decide(r);
          const client = getClient(r.clientId);
          const letter = followUpLetter(r, { name: client?.name ?? "", address: "[client address]" }, client?.lang ?? lang);
          return (
            <li key={`${r.clientId}-${r.creditor}`} className="card p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-lg font-bold">{r.creditor} <span className="text-sm font-medium text-slate-500">· {r.bureau}</span></p>
                  <Link href={`/clients/${r.clientId}`} className="text-sm font-medium text-indigo-700">{client?.name}</Link>
                  <span className="text-sm text-slate-500"> · {r.daysSinceSent} {t("day")}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <span className={`chip ${OUTCOME_TONE[r.outcome]}`}>{t(r.outcome)}</span>
                  <span className={`chip ${STATUS_TONE[d.status]}`}>→ {d.status}</span>
                  <span className={`chip ${d.needsApproval ? "bg-fuchsia-100 text-fuchsia-700" : "bg-slate-100 text-slate-600"}`}>
                    {d.needsApproval ? t("needsYou") : t("auto")}
                  </span>
                </div>
              </div>
              <p className="mt-3 text-sm text-slate-600">{t(d.next)}</p>
              {letter && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm font-semibold text-indigo-700">{t("draft")}</summary>
                  <pre className="mt-2 whitespace-pre-wrap rounded-2xl bg-slate-50 p-4 text-sm text-slate-700">{letter}</pre>
                  <Link href="/mail" className="btn-primary mt-3">{t("approve")}</Link>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </Shell>
  );
}
