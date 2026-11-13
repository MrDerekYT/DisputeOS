import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import { AuthLayout } from '@/components/auth-layout';
import { ActionForm, Check, Field, Select, SubmitButton, TextArea } from '@/components/forms';
import { orgBrandBySlug, portalLoginPath } from '@/lib/org-brand';
import { LEAD_GOALS } from '@/lib/leads';
import { submitLeadAction } from './actions';

export const metadata: Metadata = { title: 'Get started', robots: { index: false } };

/** An agency's public enquiry form. It collects contact details only — never SSNs, dates of birth or account numbers. */
export default async function LeadFormPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ sent?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const brand = await orgBrandBySlug(slug);
  if (!brand) notFound();
  if (sp.sent) {
    return (
      <AuthLayout portal brand={brand} title="Thank you — we’ve got it" subtitle={`Someone from ${brand.name} will contact you soon. You don’t need to do anything else for now.`}
        footer={<>Already a client? <Link href={portalLoginPath(brand.slug)} className="font-medium text-brand-strong hover:underline">Sign in to your portal</Link></>}>
        <p className="flex items-start gap-2.5 rounded-xl bg-ok-soft p-3.5 text-sm"><CheckCircle2 size={18} className="mt-0.5 shrink-0 text-ok" aria-hidden /> Your details were sent securely. Please don’t email sensitive information such as your Social Security number.</p>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout portal brand={brand} title="A home, a car, a better card — it starts with accurate credit" subtitle={`Tell ${brand.name} what you’re working toward and how to reach you. There is no cost and no obligation to ask.`}
      footer={<>Already a client? <Link href={portalLoginPath(brand.slug)} className="font-medium text-brand-strong hover:underline">Sign in to your portal</Link></>}>
      <ActionForm action={submitLeadAction} className="space-y-4">
        <input type="hidden" name="slug" value={brand.slug} />
        {/* Honeypot: hidden from people, filled by bots. */}
        <div className="hidden" aria-hidden><label>Company website<input name="company_website" tabIndex={-1} autoComplete="off" /></label></div>
        <Field label="Your name" name="fullName" autoComplete="name" required maxLength={120} />
        <Field label="Email" name="email" type="email" autoComplete="email" required maxLength={200} />
        <Field label="Phone" name="phone" type="tel" autoComplete="tel" maxLength={30} hint="Optional" />
        <Select label="What are you working toward?" name="goal" placeholder="Choose…" options={Object.entries(LEAD_GOALS).map(([value, label]) => ({ value, label }))} />
        <Select label="Preferred language" name="language" defaultValue="en" options={[{ value: 'en', label: 'English' }, { value: 'es', label: 'Español' }]} />
        <TextArea label="What would you like help with?" name="message" rows={3} maxLength={1000} hint="Optional. Please don’t include your Social Security number or account numbers here." />
        <Check name="consent">I agree that {brand.name} may contact me about its services using the details above.</Check>
        <SubmitButton className="w-full" pendingText="Sending…">Send</SubmitButton>
      </ActionForm>
      <p className="mt-5 text-xs leading-relaxed text-muted">Asking is free. We help you check your reports and dispute what is inaccurate; lenders make their own decisions, so no one can promise an approval, a specific result or a higher credit score, and you have the right to dispute inaccurate information with the credit bureaus yourself at no cost.</p>
    </AuthLayout>
  );
}
