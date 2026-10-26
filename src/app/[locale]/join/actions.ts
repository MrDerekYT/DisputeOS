"use server";

import { validateIntake, verifyInvite } from "@/lib/invite";

export interface IntakeState {
  status: "idle" | "error" | "done";
  errors?: Record<string, string>;
  preview?: boolean;
}

export async function submitIntake(token: string, _prev: IntakeState, form: FormData): Promise<IntakeState> {
  const invite = verifyInvite(token);
  if (!invite) return { status: "error", errors: { form: "invite" } };
  const v = validateIntake({
    name: form.get("name"), email: form.get("email"), phone: form.get("phone"), address: form.get("address"),
    consentCroa: form.get("consentCroa"), consentReports: form.get("consentReports"),
  });
  if (!v.ok) return { status: "error", errors: v.errors };

  // Persistence needs Supabase (migrations not yet applied). Never pretend to store in production.
  if (process.env.NODE_ENV === "production" && process.env.INTAKE_PREVIEW !== "1") return { status: "error", errors: { form: "storage" } };
  return { status: "done", preview: true };
}
