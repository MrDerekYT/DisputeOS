'use client';

import { useActionState } from 'react';
import { importReport } from './actions';
import { CSV_TEMPLATE } from '@/lib/import';

export default function ImportReport() {
  const [state, action, pending] = useActionState(importReport, undefined);
  const template = `data:text/csv;charset=utf-8,${encodeURIComponent(CSV_TEMPLATE)}`;
  return (
    <form action={action} className="max-w-lg space-y-3">
      <h1 className="text-2xl font-bold">Import credit report</h1>
      <p className="text-sm">
        Upload a CSV of report items. Full account numbers are reduced to the last 4 characters.{' '}
        <a className="underline" href={template} download="tradelines-template.csv">
          Download template
        </a>
      </p>
      <label className="block text-sm">
        Client ID
        <input name="clientId" required className="mt-1 w-full rounded border p-2" />
      </label>
      <label className="block text-sm">
        CSV file
        <input name="file" type="file" accept=".csv,text/csv" required className="mt-1 w-full" />
      </label>
      {state?.errors && (
        <ul role="alert" className="list-disc pl-5 text-sm text-red-600">
          {state.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <button
        disabled={pending}
        className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
      >
        {pending ? 'Importing…' : 'Import'}
      </button>
    </form>
  );
}
