"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { classifyAction, updateAction, type ReplyResult, type UpdateResult } from "./actions";

export function ReplyTool({ lang }: { lang: string }) {
  const t = useTranslations("copilot");
  const [s, act, pending] = useActionState<ReplyResult, FormData>(classifyAction, {});
  return (
    <form action={act} className="card space-y-3 p-6">
      <h2 className="text-xl font-bold">{t("replyTitle")}</h2>
      <p className="text-sm text-slate-600">{t("replySub")}</p>
      <input type="hidden" name="lang" value={lang} />
      <textarea name="reply" rows={5} maxLength={5000} placeholder={t("replyPh")} className="w-full p-3 text-sm" />
      <div className="grid gap-3 sm:grid-cols-3">
        <input name="creditor" placeholder={t("creditor")} className="p-3 text-sm" />
        <input name="bureau" placeholder={t("bureau")} className="p-3 text-sm" />
        <input name="days" type="number" min={0} max={365} placeholder={t("days")} className="p-3 text-sm" />
      </div>
      <button disabled={pending} className="btn-primary">{pending ? "…" : t("analyze")}</button>
      {s.error && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">{t("unclear")}</p>}
      {s.outcome && (
        <div className="space-y-2 rounded-2xl bg-slate-50 p-4 text-sm">
          <p><b>{t("detected")}:</b> {s.outcome} → {s.status} · {s.needsApproval ? t("needsYou") : t("auto")}</p>
          <p className="text-slate-600">{t("confirm")}</p>
          {s.letter && <pre className="whitespace-pre-wrap rounded-xl bg-white p-3">{s.letter}</pre>}
        </div>
      )}
    </form>
  );
}

export function UpdateTool({ clients }: { clients: { id: string; name: string }[] }) {
  const t = useTranslations("copilot");
  const [s, act, pending] = useActionState<UpdateResult, FormData>(updateAction, {});
  return (
    <form action={act} className="card space-y-3 p-6">
      <h2 className="text-xl font-bold">{t("updateTitle")}</h2>
      <p className="text-sm text-slate-600">{t("updateSub")}</p>
      <select name="client" className="w-full p-3 text-sm">
        {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <button disabled={pending} className="btn-primary">{pending ? "…" : t("write")}</button>
      {s.text && (
        <div className="rounded-2xl bg-slate-50 p-4 text-sm">
          <p>{s.text}</p>
          <p className="mt-2 text-xs text-slate-500">{s.usedAi ? t("aiOn") : t("aiOff")}</p>
        </div>
      )}
    </form>
  );
}
