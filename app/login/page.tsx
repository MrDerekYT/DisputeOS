'use client';

import { useActionState } from 'react';
import { signIn } from './actions';

export default function Login() {
  const [state, action, pending] = useActionState(signIn, undefined);
  return (
    <form action={action} className="mx-auto max-w-sm space-y-3">
      <h1 className="text-2xl font-bold">Sign in</h1>
      <label className="block">
        <span className="text-sm">Email</span>
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          className="mt-1 w-full rounded border p-2"
        />
      </label>
      <label className="block">
        <span className="text-sm">Password</span>
        <input
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="current-password"
          className="mt-1 w-full rounded border p-2"
        />
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
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
