"use client";

import { useActionState } from "react";
import { submitIntake, type IntakeState } from "./actions";

export interface IntakeCopy {
  name: string; email: string; phone: string; address: string; addressHint: string;
  consentCroa: string; consentReports: string; submit: string;
  doneTitle: string; doneBody: string; preview: string;
  errField: string; errConsent: string; errInvite: string; errStorage: string;
}

export function IntakeForm({ token, defaultName, copy }: { token: string; defaultName: string; copy: IntakeCopy }) {
  const [state, action, pending] = useActionState<IntakeState, FormData>(submitIntake.bind(null, token), { status: "idle" });
  const e = state.errors ?? {};

  if (state.status === "done") {
    return (
      <div className="py-8 text-center">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 text-3xl text-white shadow-lg shadow-emerald-500/30">✓</div>
        <h2 className="mt-4 text-2xl font-extrabold">{copy.doneTitle}</h2>
        <p className="mt-2 text-slate-600">{copy.doneBody}</p>
        {state.preview && <p className="mt-4 text-xs text-amber-700">{copy.preview}</p>}
      </div>
    );
  }

  const field = (key: "name" | "email" | "phone", label: string, type: string, auto: string, def = "") => (
    <label className="block">
      <span className="text-sm font-semibold text-slate-700">{label}</span>
      <input name={key} type={type} autoComplete={auto} defaultValue={def} required
        aria-invalid={!!e[key]}
        className={`mt-1 w-full rounded-xl border bg-white px-3.5 py-3 text-base outline-none transition focus:ring-2 focus:ring-indigo-500/40 ${e[key] ? "border-rose-400" : "border-slate-200"}`} />
      {e[key] && <span className="mt-1 block text-xs text-rose-600">{copy.errField}</span>}
    </label>
  );

  return (
    <form action={action} className="space-y-4">
      {e.form && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{e.form === "invite" ? copy.errInvite : copy.errStorage}</p>}
      {field("name", copy.name, "text", "name", defaultName)}
      <div className="grid gap-4 sm:grid-cols-2">
        {field("email", copy.email, "email", "email")}
        {field("phone", copy.phone, "tel", "tel")}
      </div>
      <label className="block">
        <span className="text-sm font-semibold text-slate-700">{copy.address}</span>
        <input name="address" autoComplete="street-address" placeholder={copy.addressHint} required
          className={`mt-1 w-full rounded-xl border bg-white px-3.5 py-3 text-base outline-none transition focus:ring-2 focus:ring-indigo-500/40 ${e.address ? "border-rose-400" : "border-slate-200"}`} />
        {e.address && <span className="mt-1 block text-xs text-rose-600">{copy.errField}</span>}
      </label>
      <div className="space-y-3 rounded-2xl bg-slate-50 p-4 text-sm">
        {([["consentCroa", copy.consentCroa], ["consentReports", copy.consentReports]] as const).map(([k, label]) => (
          <label key={k} className="flex items-start gap-3">
            <input type="checkbox" name={k} className="mt-1 h-4 w-4 accent-indigo-600" />
            <span className={e[k] ? "text-rose-700" : "text-slate-700"}>{label}</span>
          </label>
        ))}
        {(e.consentCroa || e.consentReports) && <p className="text-xs text-rose-600">{copy.errConsent}</p>}
      </div>
      <button disabled={pending} className="btn-primary w-full py-3.5 text-base">{pending ? "…" : copy.submit}</button>
    </form>
  );
}
