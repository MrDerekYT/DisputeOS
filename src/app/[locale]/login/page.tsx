import { getTranslations, setRequestLocale } from "next-intl/server";
import { supabaseServer } from "@/lib/supabase-server";
import { redirect } from "@/i18n/routing";
import { credentialsMatch, previewAuthEnabled, startAdminSession } from "@/lib/access";

async function signIn(locale: string, formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  if (previewAuthEnabled()) {
    if (!credentialsMatch(email, password)) redirect({ href: "/login?error=1", locale });
    await startAdminSession();
    redirect({ href: "/dashboard", locale });
  }
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) redirect({ href: "/login?error=1", locale });
  const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  // Staff must complete the second factor before reaching the app.
  redirect({ href: data?.nextLevel === "aal2" && data.currentLevel !== "aal2" ? "/login?mfa=1" : "/dashboard", locale });
}

export default async function Login({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ mfa?: string; error?: string }>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("auth");
  return (
    <main className="grid min-h-screen place-items-center p-5">
      <div className="card w-full max-w-md p-8">
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-indigo-600 to-fuchsia-500 text-xl font-extrabold text-white shadow-lg shadow-fuchsia-500/30">D</span>
        <h1 className="mt-5 text-2xl font-extrabold tracking-tight">{t("title")}</h1>
        <p className="mt-1 text-sm text-slate-500">{t("staffOnly")}</p>
        {sp.error && <p role="alert" className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{t("invalid")}</p>}
        {sp.mfa && <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">{t("mfaRequired")}</p>}
        <form action={signIn.bind(null, locale)} className="mt-6 space-y-4">
          <label className="block text-sm font-semibold">
            {t("email")}
            <input name="email" type="email" required autoComplete="username webauthn" className="mt-1 w-full p-3" />
          </label>
          <label className="block text-sm font-semibold">
            {t("password")}
            <input name="password" type="password" required autoComplete="current-password" className="mt-1 w-full p-3" />
          </label>
          <button className="btn-primary w-full">{t("submit")}</button>
        </form>
      </div>
    </main>
  );
}
