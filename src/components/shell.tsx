import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/routing";

const ITEMS = [
  ["/dashboard", "dashboard", "M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"],
  ["/clients", "clients", "M16 11a4 4 0 10-8 0 4 4 0 008 0zM4 21c0-4 4-6 8-6s8 2 8 6"],
  ["/reports", "reports", "M6 2h9l5 5v15H6V2zm8 1.5V8h4.5M9 13h8M9 17h8"],
  ["/analysis", "analysis", "M4 20V10m6 10V4m6 16v-7m4 7H2"],
  ["/responses", "responses", "M4 4h16v12H8l-4 4V4zm4 5h8M8 12h5"],
  ["/mail", "mail", "M3 6h18v12H3V6zm0 0l9 7 9-7"],
] as const;

export async function Shell({ locale, active, children }: { locale: string; active: string; children: React.ReactNode }) {
  const t = await getTranslations("nav");
  return (
    <div className="mx-auto flex min-h-screen max-w-[88rem] gap-6 p-3 md:p-5">
      <aside className="no-print sticky top-5 hidden h-[calc(100vh-2.5rem)] w-64 shrink-0 flex-col rounded-3xl bg-slate-900 p-4 text-slate-300 shadow-2xl shadow-slate-900/20 md:flex">
        <Link href="/" className="flex items-center gap-3 px-2 py-2 text-lg font-extrabold text-white">
          <span className="grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white shadow-lg shadow-fuchsia-500/30">D</span>
          DisputeOS
        </Link>
        <nav className="mt-6 flex flex-1 flex-col gap-1" aria-label="Main">
          {ITEMS.map(([href, key, d]) => (
            <Link key={key} href={href} aria-current={active === key ? "page" : undefined}
              className={`flex min-h-[44px] items-center gap-3 rounded-2xl px-3.5 text-sm font-medium transition ${
                active === key ? "bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-lg shadow-indigo-500/30" : "hover:bg-white/10 hover:text-white"}`}>
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
              {t(key)}
            </Link>
          ))}
        </nav>
        <div className="flex gap-2 rounded-2xl bg-white/5 p-1 text-xs font-semibold">
          <Link href="/" locale="en" className={`flex-1 rounded-xl py-2 text-center ${locale === "en" ? "bg-white text-slate-900" : "hover:bg-white/10"}`}>EN</Link>
          <Link href="/" locale="es" className={`flex-1 rounded-xl py-2 text-center ${locale === "es" ? "bg-white text-slate-900" : "hover:bg-white/10"}`}>ES</Link>
        </div>
      </aside>
      <main className="min-w-0 flex-1 pb-24 md:pb-10">{children}</main>
      <nav aria-label="Main" className="no-print fixed inset-x-3 bottom-3 z-20 grid grid-cols-6 rounded-3xl bg-slate-900/95 p-1.5 shadow-2xl backdrop-blur md:hidden">
        {ITEMS.map(([href, key, d]) => (
          <Link key={key} href={href} aria-current={active === key ? "page" : undefined}
            className={`flex min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-2xl text-[10px] font-semibold ${active === key ? "bg-gradient-to-br from-indigo-500 to-violet-500 text-white" : "text-slate-400"}`}>
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
            {t(key)}
          </Link>
        ))}
      </nav>
    </div>
  );
}
