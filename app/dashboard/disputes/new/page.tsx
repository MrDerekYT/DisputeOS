'use client';

import { useActionState } from 'react';
import { BUREAUS } from '@/lib/disputes';
import { createDispute } from './actions';

export default function NewDispute() {
  const [state, action, pending] = useActionState(createDispute, undefined);
  const input = 'mt-1 w-full rounded border p-2';
  return (
    <form action={action} className="max-w-lg space-y-3">
      <h1 className="text-2xl font-bold">New dispute</h1>
      <label className="block text-sm">
        Client ID
        <input name="clientId" required className={input} />
      </label>
      <label className="block text-sm">
        Tradeline ID
        <input name="tradelineId" required className={input} />
      </label>
      <label className="block text-sm">
        Bureau
        <select name="bureau" className={`${input} capitalize`}>
          {BUREAUS.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        Reason
        <textarea name="reason" required minLength={10} rows={4} className={input} />
      </label>
      {state?.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}
      <button
        disabled={pending}
        className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
      >
        Create
      </button>
    </form>
  );
}
