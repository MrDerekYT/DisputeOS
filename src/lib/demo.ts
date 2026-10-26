export type Stage = "intake" | "analysis" | "disputing" | "monitoring";
export type ItemStatus = "draft" | "sent" | "investigating" | "removed";
export type Issue = "notMine" | "late" | "duplicate" | "obsolete" | "balance";
export type Task = "uploadId" | "proofAddress" | "reviewLetters";

export interface DemoClient {
  id: string;
  name: string;
  lang: "en" | "es";
  stage: Stage;
  startScore: number;
  score: number;
  daysIn: number;
  nextAction: "reviewFindings" | "approveLetters" | "waitBureau" | "monthlyReview" | "collectDocs";
  clientTasks: Task[];
  items: { creditor: string; issue: Issue; status: ItemStatus; bureau: string }[];
  history: number[];
}

// Demo data only until the database is connected.
export const DEMO_CLIENTS: DemoClient[] = [
  {
    id: "jordan-rivera", name: "Jordan Rivera", lang: "en", stage: "disputing", startScore: 548, score: 612, daysIn: 118,
    nextAction: "waitBureau", clientTasks: ["reviewLetters"], history: [548, 561, 570, 589, 604, 612],
    items: [
      { creditor: "Midland Credit", issue: "notMine", status: "removed", bureau: "Experian" },
      { creditor: "Capital One", issue: "late", status: "investigating", bureau: "Equifax" },
      { creditor: "Portfolio Recovery", issue: "duplicate", status: "sent", bureau: "TransUnion" },
      { creditor: "Synchrony", issue: "balance", status: "removed", bureau: "Experian" },
    ],
  },
  {
    id: "maria-gomez", name: "María Gómez", lang: "es", stage: "analysis", startScore: 521, score: 521, daysIn: 9,
    nextAction: "reviewFindings", clientTasks: ["uploadId"], history: [521, 521],
    items: [
      { creditor: "LVNV Funding", issue: "obsolete", status: "draft", bureau: "Equifax" },
      { creditor: "Discover", issue: "balance", status: "draft", bureau: "Experian" },
    ],
  },
  {
    id: "sam-lee", name: "Sam Lee", lang: "en", stage: "intake", startScore: 0, score: 0, daysIn: 2,
    nextAction: "collectDocs", clientTasks: ["uploadId", "proofAddress"], history: [], items: [],
  },
  {
    id: "alicia-torres", name: "Alicia Torres", lang: "es", stage: "monitoring", startScore: 502, score: 641, daysIn: 240,
    nextAction: "monthlyReview", clientTasks: [], history: [502, 530, 561, 588, 612, 641],
    items: [
      { creditor: "Cavalry SPV", issue: "notMine", status: "removed", bureau: "TransUnion" },
      { creditor: "Ally Financial", issue: "late", status: "removed", bureau: "Equifax" },
      { creditor: "Midland Credit", issue: "duplicate", status: "removed", bureau: "Experian" },
    ],
  },
  {
    id: "devon-brooks", name: "Devon Brooks", lang: "en", stage: "disputing", startScore: 567, score: 579, daysIn: 41,
    nextAction: "approveLetters", clientTasks: [], history: [567, 570, 579],
    items: [
      { creditor: "Verizon", issue: "balance", status: "draft", bureau: "Experian" },
      { creditor: "Credit One", issue: "late", status: "sent", bureau: "Equifax" },
    ],
  },
];

export const getClient = (id: string) => DEMO_CLIENTS.find((c) => c.id === id);
export const STAGES: Stage[] = ["intake", "analysis", "disputing", "monitoring"];

export const summarize = (c: DemoClient) => {
  const removed = c.items.filter((i) => i.status === "removed").length;
  return { removed, total: c.items.length, gain: c.score && c.startScore ? c.score - c.startScore : 0, pct: c.items.length ? Math.round((removed / c.items.length) * 100) : 0 };
};

export const STATUS_TONE: Record<ItemStatus, string> = {
  draft: "bg-slate-100 text-slate-600",
  sent: "bg-blue-100 text-blue-700",
  investigating: "bg-amber-100 text-amber-700",
  removed: "bg-emerald-100 text-emerald-700",
};

export const initials = (n: string) => n.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
