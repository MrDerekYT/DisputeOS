'use client';

import { useActionState, useEffect, useRef, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/util';

export type ActionState = { error?: string; ok?: string; data?: Record<string, string> } | undefined;
type ServerAction = (prev: ActionState, fd: FormData) => Promise<ActionState>;

export function SubmitButton({ children, className, variant = 'primary', pendingText }: { children: ReactNode; className?: string; variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; pendingText?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-busy={pending} className={cn(`btn-${variant}`, className)}>
      {pending && <Loader2 size={16} className="animate-spin" aria-hidden />}
      {pending && pendingText ? pendingText : children}
    </button>
  );
}

/** A form bound to a server action with inline success/error feedback (announced to screen readers). */
export function ActionForm({
  action, children, className, resetOnSuccess = false, onSuccessHref,
}: { action: ServerAction; children: ReactNode; className?: string; resetOnSuccess?: boolean; onSuccessHref?: string }) {
  const [state, run] = useActionState(action, undefined);
  const ref = useRef<HTMLFormElement>(null);
  const last = useRef<FormData | null>(null);
  useEffect(() => {
    if (state?.ok && resetOnSuccess) ref.current?.reset();
    if (state?.ok && onSuccessHref) window.location.assign(onSuccessHref);
    // React clears an uncontrolled form once its action finishes. When the action came back with an error,
    // put back what the person typed so they never have to retype it.
    if (ref.current && last.current && state?.error) restoreForm(ref.current, last.current);
  }, [state, resetOnSuccess, onSuccessHref]);
  return (
    <form ref={ref} action={run} className={className} onSubmit={(e) => { last.current = new FormData(e.currentTarget); }}>
      {children}
      <div aria-live="polite" className="empty:hidden">
        {state?.error && (
          <p role="alert" className="mt-3 flex items-start gap-2 rounded-xl bg-bad-soft px-3.5 py-2.5 text-sm text-bad">
            <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden /> {state.error}
          </p>
        )}
        {state?.ok && (
          <p className="mt-3 flex items-start gap-2 rounded-xl bg-ok-soft px-3.5 py-2.5 text-sm text-ok">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden /> {state.ok}
          </p>
        )}
      </div>
    </form>
  );
}

export function Field({
  label, name, type = 'text', required, defaultValue, placeholder, hint, autoComplete, maxLength, inputMode, pattern, className, min, max, step,
}: {
  label: string; name: string; type?: string; required?: boolean; defaultValue?: string | number | null; placeholder?: string; hint?: string;
  autoComplete?: string; maxLength?: number; inputMode?: 'numeric' | 'text' | 'email' | 'tel' | 'decimal'; pattern?: string; className?: string; min?: string | number; max?: string | number; step?: string | number;
}) {
  return (
    <div className={className}>
      <label className="label" htmlFor={name}>
        {label}{required && <span className="text-bad" aria-hidden> *</span>}
      </label>
      <input id={name} name={name} type={type} required={required} defaultValue={defaultValue ?? undefined} placeholder={placeholder}
        autoComplete={autoComplete} maxLength={maxLength} inputMode={inputMode} pattern={pattern} min={min} max={max} step={step} className="field" />
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function TextArea({ label, name, rows = 4, required, defaultValue, placeholder, hint, maxLength, className }: {
  label: string; name: string; rows?: number; required?: boolean; defaultValue?: string | null; placeholder?: string; hint?: string; maxLength?: number; className?: string;
}) {
  return (
    <div className={className}>
      <label className="label" htmlFor={name}>{label}{required && <span className="text-bad" aria-hidden> *</span>}</label>
      <textarea id={name} name={name} rows={rows} required={required} defaultValue={defaultValue ?? undefined} placeholder={placeholder} maxLength={maxLength} className="field resize-y" />
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function Select({ label, name, options, defaultValue, required, hint, className, placeholder }: {
  label: string; name: string; options: { value: string; label: string }[]; defaultValue?: string | null; required?: boolean; hint?: string; className?: string; placeholder?: string;
}) {
  return (
    <div className={className}>
      <label className="label" htmlFor={name}>{label}{required && <span className="text-bad" aria-hidden> *</span>}</label>
      <select id={name} name={name} required={required} defaultValue={defaultValue ?? ''} className="field">
        {placeholder != null && <option value="">{placeholder}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function Check({ name, children, defaultChecked, required, value }: { name: string; children: ReactNode; defaultChecked?: boolean; required?: boolean; value?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 text-sm">
      <input type="checkbox" name={name} value={value} defaultChecked={defaultChecked} required={required} className="mt-0.5 h-4 w-4 shrink-0 rounded border-line accent-[rgb(var(--brand))]" />
      <span>{children}</span>
    </label>
  );
}

/** Confirm-before-submit for destructive or outward-facing actions. */
export function ConfirmButton({ children, message, className = 'btn-secondary btn-sm' }: { children: ReactNode; message: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className} onClick={(e) => { if (!window.confirm(message)) e.preventDefault(); }}>
      {children}
    </button>
  );
}

/** Re-applies submitted values to a form. Passwords and files are deliberately left empty. */
function restoreForm(form: HTMLFormElement, data: FormData) {
  for (const el of Array.from(form.elements)) {
    if (el instanceof HTMLInputElement) {
      if (!el.name || el.type === 'password' || el.type === 'file' || el.type === 'hidden' || el.type === 'submit') continue;
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = data.getAll(el.name).includes(el.value);
      else { const v = data.get(el.name); if (typeof v === 'string') el.value = v; }
    } else if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      const v = el.name ? data.get(el.name) : null;
      if (typeof v === 'string') el.value = v;
    }
  }
}
