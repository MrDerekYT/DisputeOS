import { getTranslations, setRequestLocale } from "next-intl/server";
import { Shell } from "@/components/shell";
import { importClientsCsv } from "@/lib/import/csv";

const SAMPLE = `Full Name,Email,Phone,Address
Jordan Rivera,jordan@example.com,(512) 555-0100,"123 Main St, Austin, TX 78701"
Maria Gomez,maria@example.com,512-555-0111,"45 Oak Ave, Dallas, TX 75201"
Maria Gomez,maria@example.com,512-555-0111,"45 Oak Ave, Dallas, TX 75201"
Sam Lee,not-an-email,5125550122,"9 Pine Rd, Houston, TX 77001"`;

export default async function Clients({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ csv?: string }> }) {
  const { locale } = await params;
  const { csv } = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("clients");
  const source = csv?.slice(0, 100_000) || SAMPLE;
  const r = importClientsCsv(source);
  const mask = (p: string) => (p.length === 10 ? `(•••) •••-${p.slice(6)}` : "—");

  return (
    <Shell locale={locale} active="clients">
      <h1 className="text-3xl font-extrabold tracking-tight">{t("title")}</h1>
      <p className="mt-1 max-w-2xl text-sm text-slate-600">{t("subtitle")}</p>

      <form className="card mt-6 p-5">
        <textarea name="csv" defaultValue={source} rows={6} className="w-full rounded-xl border border-slate-200 bg-white p-3 font-mono text-xs" />
        <button className="btn-primary mt-3">{t("preview")}</button>
      </form>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {[
          [t("ready"), r.rows.length, "from-emerald-500 to-teal-500"],
          [t("duplicates"), r.duplicates, "from-amber-500 to-orange-500"],
          [t("errors"), r.errors.length, "from-rose-500 to-pink-500"],
        ].map(([label, n, g]) => (
          <div key={String(label)} className="card relative overflow-hidden p-5">
            <div className={`absolute -right-6 -top-6 h-20 w-20 rounded-full bg-gradient-to-br ${g} opacity-20`} />
            <div className="text-sm text-slate-500">{label}</div>
            <div className="text-3xl font-extrabold">{n}</div>
          </div>
        ))}
      </div>

      <div className="card mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr>{[t("name"), t("email"), t("phone"), t("address")].map((h) => <th key={h} className="px-4 py-3">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y">
            {r.rows.map((c) => (
              <tr key={c.email || c.name}>
                <td className="px-4 py-3 font-semibold">{c.name}</td>
                <td className="px-4 py-3">{c.email || "—"}</td>
                <td className="px-4 py-3 font-mono text-xs">{mask(c.phone)}</td>
                <td className="px-4 py-3 text-slate-600">{c.address || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {r.errors.length > 0 && (
        <ul className="card mt-4 space-y-1 p-4 text-sm text-rose-700">
          {r.errors.map((e) => <li key={e.line}>{t("line")} {e.line}: {e.message}</li>)}
        </ul>
      )}
      <p className="mt-4 text-xs text-slate-500">{t("note")}</p>
    </Shell>
  );
}
