import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/routing";

const ITEMS = [
  ["/dashboard", "dashboard", "M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"],
  ["/clients", "clients", "M16 11a4 4 0 10-8 0 4 4 0 008 0zM4 21c0-4 4-6 8-6s8 2 8 6"],
  ["/reports", "reports", "M6 2h9l5 5v15H6V2zm8 1.5V8h4.5M9 13h8M9 17h8"],
  ["/analysis", "analysis", "M4 20V10m6 10V4m6 16v-7m4 7H2"],
  ["/mail", "mail", "M3 6h18v12H3V6zm0 0l9 7 9-7"],
] as const;

export async function Shell({ locale, active, children }: { locale: string; active: string; children: React.ReactNode }) {
  const t = await getTranslations("nav");
  return (
    <div className="mx-auto flex min-h-screen max-w-7xl gap-6 p-4 md:p-6">
      <aside className="no-print card sticky top-6 hidden h-[calc(100vh-3rem)] w-60 shrink-0 flex-col p-4 md:flex">
        <Link href="/" className="flex items-center gap-2.5 px-2 py-1.5 text-lg font-extrabold">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-lg shadow-indigo-500/30">D</span>
          DisputeOS
        </Link>
        <nav className="mt-6 flex flex-1 flex-col gap-1">
          {ITEMS.map(([href, key, d]) => (
            <Link key={key} href={href}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                active === key ? "bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-md shadow-indigo-500/25" : "text-slate-600 hover:bg-slate-100"}`}>
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
              {t(key)}
            </Link>
          ))}
        </nav>
        <div className="flex gap-2 text-xs">
          <Link href="/" locale="en" className={`flex-1 rounded-lg py-1.5 text-center ${locale === "en" ? "bg-slate-900 text-white" : "bg-slate-100"}`}>EN</Link>
          <Link href="/" locale="es" className={`flex-1 rounded-lg py-1.5 text-center ${locale === "es" ? "bg-slate-900 text-white" : "bg-slate-100"}`}>ES</Link>
        </div>
      </aside>
      <main className="min-w-0 flex-1 pb-10">{children}</main>
    </div>
  );
}
