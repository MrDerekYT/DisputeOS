import { getTranslations, setRequestLocale } from "next-intl/server";
import { fieldsNeedingReview, last4Of, parseReportText } from "@/lib/reports/parser";
import { SAMPLE_REPORT } from "@/lib/reports/sample";
import type { Field, ParsedTradeline } from "@/lib/reports/types";

const ORDER: (keyof ParsedTradeline)[] = [
  "creditor", "accountNumber", "accountType", "accountStatus", "paymentStatus",
  "dateOpened", "dofd", "balance", "highCredit", "creditLimit", "originalCreditor", "paymentHistory",
];

const show = (key: keyof ParsedTradeline, f: Field<string | number>) => {
  if (f.value === null) return "—";
  if (key === "accountNumber") return `•••• ${last4Of(String(f.value))}`; // never render full account numbers
  if (typeof f.value === "number") return f.value.toLocaleString("en-US", { style: "currency", currency: "USD" });
  return String(f.value);
};

export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ text?: string }>;
}) {
  const { locale } = await params;
  const { text } = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("reports");
  const source = text?.slice(0, 50_000) || SAMPLE_REPORT;
  const report = parseReportText(source);

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <p className="mt-1 text-sm text-slate-600">{t("subtitle")}</p>

      <form className="mt-4">
        <textarea name="text" defaultValue={source} rows={8} className="w-full rounded border p-2 font-mono text-xs" />
        <button className="mt-2 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white">{t("parse")}</button>
      </form>

      <p className="mt-6 text-sm">
        {t("bureau")}: <b>{report.bureau ?? "?"}</b> · {t("accounts")}: <b>{report.tradelines.length}</b> ·{" "}
        {t("inquiries")}: <b>{report.inquiries.length}</b>
      </p>
      {report.warnings.length > 0 && (
        <ul className="mt-3 list-disc rounded bg-amber-50 p-3 pl-7 text-sm text-amber-800">
          {report.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}

      {report.tradelines.map((tl, i) => {
        const flagged = new Set(fieldsNeedingReview(tl));
        return (
          <section key={i} className="mt-6 rounded-xl border bg-white p-5">
            <h2 className="text-lg font-semibold">{tl.creditor.value}</h2>
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-slate-500">
                  <th className="py-1">{t("field")}</th><th>{t("extracted")}</th><th>{t("sourceLine")}</th><th>{t("confidence")}</th>
                </tr>
              </thead>
              <tbody>
                {ORDER.map((k) => {
                  const f = tl[k] as Field<string | number>;
                  return (
                    <tr key={k} className={`border-t ${flagged.has(k) ? "bg-amber-50" : ""}`}>
                      <td className="py-1.5 font-medium">{k}</td>
                      <td>{show(k, f)}</td>
                      <td className="font-mono text-xs text-slate-500">{f.source && k !== "accountNumber" ? f.source : f.source ? "Account Number: ••••" : ""}</td>
                      <td>{f.source ? `${Math.round(f.confidence * 100)}%${flagged.has(k) ? " ⚠" : ""}` : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })}

      {report.inquiries.length > 0 && (
        <section className="mt-6 rounded-xl border bg-white p-5">
          <h2 className="font-semibold">{t("inquiries")}</h2>
          <ul className="mt-2 text-sm">
            {report.inquiries.map((q) => <li key={q.source}>{q.name} — {q.date ?? "?"}</li>)}
          </ul>
        </section>
      )}
      <p className="mt-8 text-xs text-slate-500">{t("pageNote")}</p>
    </main>
  );
}
