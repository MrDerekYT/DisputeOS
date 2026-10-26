import { assertSafe } from "@/lib/analysis/letters";
import { scrubPii } from "@/lib/scrub";
import type { DemoClient } from "@/lib/demo";

type Lang = "en" | "es";

/** Plain-language progress note for a client, built from case facts only. */
export function clientUpdateText(c: DemoClient, lang: Lang): string {
  const removed = c.items.filter((i) => i.status === "removed").length;
  const waiting = c.items.filter((i) => i.status === "sent" || i.status === "investigating").length;
  const gain = c.score && c.startScore ? c.score - c.startScore : 0;
  const first = c.name.split(" ")[0];
  const t =
    lang === "es"
      ? `Hola ${first}, aquí está su avance: ${removed} de ${c.items.length} cuentas se han eliminado y ${waiting} siguen en revisión con los burós.${gain > 0 ? ` Su puntaje ha subido ${gain} puntos desde que comenzó.` : ""} Los resultados varían y cada resultado lo deciden los burós. Le avisaremos de cada respuesta.`
      : `Hi ${first}, here is your progress: ${removed} of ${c.items.length} items have been removed and ${waiting} are still under review with the bureaus.${gain > 0 ? ` Your score is up ${gain} points since you started.` : ""} Results vary and each outcome is decided by the bureaus. We'll let you know about every response.`;
  return assertSafe(t);
}

export interface Polished { text: string; usedAi: boolean }

/**
 * Optional LLM polish through any OpenAI-compatible endpoint (AI_BASE_URL, AI_API_KEY, AI_MODEL).
 * Names are swapped for a placeholder and text is scrubbed before it leaves the server;
 * the result must still pass the blocked-claims check or the original text is kept.
 */
export async function polish(text: string, name: string): Promise<Polished> {
  const { AI_BASE_URL, AI_API_KEY, AI_MODEL } = process.env;
  if (!AI_BASE_URL || !AI_API_KEY || !AI_MODEL) return { text, usedAi: false };
  const first = name.split(" ")[0] ?? name;
  const safe = scrubPii(text.split(first).join("{NAME}"));
  try {
    const res = await fetch(`${AI_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${AI_API_KEY}` },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: "system", content: "Rewrite this credit-repair client update to be warm and clear in the same language. Keep every fact and the {NAME} placeholder. Never promise or guarantee results. Return only the message." },
          { role: "user", content: safe },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { text, usedAi: false };
    const out = ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content;
    if (!out) return { text, usedAi: false };
    return { text: assertSafe(out.split("{NAME}").join(first)), usedAi: true };
  } catch {
    return { text, usedAi: false };
  }
}
