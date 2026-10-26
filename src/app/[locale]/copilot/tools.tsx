"use client";

import { useActionState, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { classifyAction, updateAction, type ReplyResult, type UpdateResult } from "./actions";

const SAMPLES = [
  "The item has been removed from your report.",
  "The information was verified as accurate.",
  "We updated the account information.",
];

export function ReplyTool({ lang }: { lang: string }) {
  const t = useTranslations("copilot");
  const [s, act, pending] = useActionState<ReplyResult, FormData>(classifyAction, {});
  const area = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  const tone =
    s.outcome === "deleted"
      ? "bg-emerald-100 text-emerald-800"
      : s.outcome === "verified"
        ? "bg-amber-100 text-amber-800"
        : "bg-sky-100 text-sky-800";
  return (
    <form action={act} className="card space-y-3 border-t-4 border-t-indigo-500 p-6">
      <h2 className="text-xl font-bold">{t("replyTitle")}</h2>
      <p className="text-sm text-slate-600">{t("replySub")}</p>
      <input type="hidden" name="lang" value={lang} />
      <textarea ref={area} name="reply" rows={5} maxLength={5000} placeholder={t("replyPh")} className="w-full p-3 text-sm" />
      <div className="flex flex-wrap gap-2">
        {SAMPLES.map((x) => (
          <button
            key={x}
            type="button"
            onClick={() => {
              if (area.current) area.current.value = x;
            }}
            className="chip cursor-pointer bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
          >
            {x}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <input name="creditor" placeholder={t("creditor")} className="p-3 text-sm" />
        <input name="bureau" placeholder={t("bureau")} className="p-3 text-sm" />
        <input name="days" type="number" min={0} max={365} placeholder={t("days")} className="p-3 text-sm" />
      </div>
      <button disabled={pending} className="btn-primary">{pending ? "…" : t("analyze")}</button>
      {s.error && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">{t("unclear")}</p>}
      {s.outcome && (
        <div className="space-y-2 rounded-2xl bg-slate-50 p-4 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <b>{t("detected")}:</b> <span className={`chip ${tone}`}>{s.outcome}</span> → {s.status} · {s.needsApproval ? t("needsYou") : t("auto")}
          </p>
          <p className="text-slate-600">{t("confirm")}</p>
          {s.letter && (
            <>
              <pre className="whitespace-pre-wrap rounded-xl border border-slate-200 bg-white p-3">{s.letter}</pre>
              <button
                type="button"
                className="btn-ghost"
                onClick={async () => {
                  await navigator.clipboard.writeText(s.letter ?? "");
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? "✓ Copied" : "Copy letter"}
              </button>
            </>
          )}
        </div>
      )}
    </form>
  );
}

export function UpdateTool({ clients }: { clients: { id: string; name: string }[] }) {
  const t = useTranslations("copilot");
  const [s, act, pending] = useActionState<UpdateResult, FormData>(updateAction, {});
  return (
    <form action={act} className="card space-y-3 border-t-4 border-t-fuchsia-500 p-6">
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
