import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { verifyInvite } from "@/lib/invite";
import { IntakeForm, type IntakeCopy } from "../intake-form";

export default async function Join({ params }: { params: Promise<{ locale: string; token: string }> }) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("join");
  const invite = verifyInvite(decodeURIComponent(token));
  const copy: IntakeCopy = {
    name: t("name"), email: t("email"), phone: t("phone"), address: t("address"), addressHint: t("addressHint"),
    consentCroa: t("consentCroa"), consentReports: t("consentReports"), submit: t("submit"),
    doneTitle: t("doneTitle"), doneBody: t("doneBody"), preview: t("preview"),
    errField: t("errField"), errConsent: t("errConsent"), errInvite: t("errInvite"), errStorage: t("errStorage"),
  };

  return (
    <main className="mx-auto max-w-5xl px-5 py-8">
      <header className="flex items-center justify-between">
        <span className="flex items-center gap-2.5 text-lg font-extrabold">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-lg shadow-indigo-500/30">D</span>
          DisputeOS
        </span>
        <Link href={`/join/${token}`} locale={locale === "en" ? "es" : "en"} className="btn-ghost">{locale === "en" ? "Español" : "English"}</Link>
      </header>

      <div className="mt-8 grid gap-6 md:grid-cols-5">
        <aside className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-700 via-violet-700 to-fuchsia-600 p-7 text-white shadow-xl shadow-indigo-500/30 md:col-span-2">
          <div className="shine absolute inset-0" />
          <div className="relative">
            <h1 className="text-3xl font-extrabold leading-tight">{t("welcome")}</h1>
            <p className="mt-3 text-indigo-100">{t("welcomeBody")}</p>
            <ul className="mt-6 space-y-3 text-sm">
              {[t("step1"), t("step2"), t("step3")].map((s, i) => (
                <li key={s} className="flex items-center gap-3">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/20 font-bold">{i + 1}</span>{s}
                </li>
              ))}
            </ul>
            <p className="mt-8 text-xs text-indigo-200">🔒 {t("secure")}</p>
          </div>
        </aside>

        <section className="card p-6 md:col-span-3">
          {invite ? (
            <>
              <h2 className="text-xl font-extrabold">{t("formTitle")}</h2>
              <p className="mb-5 mt-1 text-sm text-slate-600">{t("formSub")}</p>
              <IntakeForm token={decodeURIComponent(token)} defaultName={invite.name ?? ""} copy={copy} />
            </>
          ) : (
            <div className="py-10 text-center">
              <div className="text-4xl">⏳</div>
              <h2 className="mt-3 text-xl font-extrabold">{t("expiredTitle")}</h2>
              <p className="mt-1 text-slate-600">{t("expiredBody")}</p>
            </div>
          )}
        </section>
      </div>
      <p className="mt-8 text-xs text-slate-500">{t("disclaimer")}</p>
    </main>
  );
}
