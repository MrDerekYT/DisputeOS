import { getTranslations, setRequestLocale } from "next-intl/server";
import { supabaseServer } from "@/lib/supabase-server";
import { redirect } from "@/i18n/routing";

async function signIn(locale: string, formData: FormData) {
  "use server";
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithPassword({
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
  });
  if (error) redirect({ href: "/login?error=1", locale });
  const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  // Staff must complete the second factor before reaching the app.
  redirect({ href: data?.nextLevel === "aal2" && data.currentLevel !== "aal2" ? "/login?mfa=1" : "/", locale });
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
    <main className="mx-auto max-w-sm p-10">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      {sp.mfa && <p className="mt-3 rounded bg-amber-50 p-3 text-sm text-amber-800">{t("mfaRequired")}</p>}
      <form action={signIn.bind(null, locale)} className="mt-6 space-y-4">
        <label className="block text-sm font-medium">
          {t("email")}
          <input name="email" type="email" required autoComplete="username webauthn" className="mt-1 w-full rounded border p-2" />
        </label>
        <label className="block text-sm font-medium">
          {t("password")}
          <input name="password" type="password" required autoComplete="current-password" className="mt-1 w-full rounded border p-2" />
        </label>
        <button className="w-full rounded-lg bg-brand py-2 font-semibold text-white">{t("submit")}</button>
      </form>
    </main>
  );
}
