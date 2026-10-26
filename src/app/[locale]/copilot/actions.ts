"use server";

import { isAdmin } from "@/lib/access";
import { clientUpdateText, polish } from "@/lib/ai";
import { classifyReply } from "@/lib/copilot";
import { getClient } from "@/lib/demo";
import { decide, followUpLetter, type BureauResponse } from "@/lib/responses";

export interface ReplyResult {
  error?: string;
  outcome?: string;
  status?: string;
  next?: string;
  needsApproval?: boolean;
  letter?: string | null;
}
export interface UpdateResult { error?: string; text?: string; usedAi?: boolean }

async function guard() {
  if (!(await isAdmin())) throw new Error("Unauthorized");
}

export async function classifyAction(_: ReplyResult, fd: FormData): Promise<ReplyResult> {
  await guard();
  const text = String(fd.get("reply") ?? "").slice(0, 5000);
  const lang = fd.get("lang") === "es" ? "es" : "en";
  const days = Math.min(Math.max(Number(fd.get("days")) || 0, 0), 365);
  const outcome = classifyReply(text) ?? (days > 0 && text.trim() === "" ? "noResponse" : null);
  if (!outcome) return { error: "unclear" };
  const r: BureauResponse = { clientId: "-", creditor: String(fd.get("creditor") ?? "").slice(0, 80) || "[creditor]", bureau: String(fd.get("bureau") ?? "").slice(0, 40) || "[bureau]", outcome, daysSinceSent: days };
  const d = decide(r);
  return { outcome, status: d.status, next: d.next, needsApproval: d.needsApproval, letter: followUpLetter(r, { name: "[client name]", address: "[client address]" }, lang) };
}

export async function updateAction(_: UpdateResult, fd: FormData): Promise<UpdateResult> {
  await guard();
  const c = getClient(String(fd.get("client") ?? ""));
  if (!c) return { error: "client" };
  const draft = clientUpdateText(c, c.lang);
  const out = await polish(draft, c.name);
  return { text: out.text, usedAi: out.usedAi };
}
