import { getTranslations, setRequestLocale } from "next-intl/server";
import { Shell } from "@/components/shell";
import { analyze } from "@/lib/analysis/analyzer";
import { writeLetter } from "@/lib/analysis/letters";
import { SAMPLE_REPORTS } from "@/lib/analysis/sample";
import { MockMailAdapter, type Address } from "@/lib/mail";

const BUREAU: Address = { name: "Credit Bureau Disputes", line1: "PO Box 4500", city: "Allen", state: "TX", zip: "75013" };
const CLIENT: Address = { name: "Jordan Rivera", line1: "123 Main St", city: "Austin", state: "TX", zip: "78701" };

export default async function MailPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("mail");
  const now = new Date();
  const adapter = new MockMailAdapter();
  const findings = analyze(SAMPLE_REPORTS).slice(0, 5);

  // Demo: the first two letters are "approved"; the rest wait for a human.
  const rows = await Promise.all(
    findings.map(async (f, i) => {
      if (i >= 2) return { f, status: "pending" as const, result: null };
      const body = writeLetter(f, { name: CLIENT.name, address: "123 Main St, Austin, TX 78701" }, locale === "es" ? "es" : "en", now);
      const result = await adapter.send({
        idempotencyKey: `demo-${f.id}`, to: BUREAU, from: CLIENT, mailClass: "certified", pages: 2, body, approvedBy: "demo-staff",
      });
      return { f, status: "sent" as const, result };
    }),
  );
  const total = rows.reduce((s, r) => s + (r.result?.costCents ?? 0), 0);

  return (
    <Shell locale={locale} active="mail">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-extrabold tracking-tight">{t("title")}</h1>
        <span className="chip bg-amber-100 text-amber-800">{t("demo")}</span>
      </div>
      <p className="mt-1 max-w-2xl text-sm text-slate-600">{t("subtitle")}</p>
      <div className="card mt-6 divide-y">
        {rows.map(({ f, status, result }) => (
          <div key={f.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <div className="font-semibold">{f.creditor}</div>
              <div className="text-sm text-slate-500">{f.title}</div>
            </div>
            <div className="flex items-center gap-3 text-sm">
              {result?.trackingNumber && <span className="font-mono text-xs text-slate-500">{result.trackingNumber}</span>}
              {result && <span className="text-slate-600">${(result.costCents / 100).toFixed(2)}</span>}
              <span className={`chip ${status === "sent" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                {status === "sent" ? t("sent") : t("needsApproval")}
              </span>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 text-sm font-semibold">{t("total")}: ${(total / 100).toFixed(2)}</p>
    </Shell>
  );
}
