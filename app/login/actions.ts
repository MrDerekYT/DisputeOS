'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { credentialsSchema, signUpSchema } from '@/lib/validation';

export type FormState =
  { error?: 'errInvalid' | 'errCredentials' | 'errSignUp'; ok?: 'checkEmail' } | undefined;

export async function signIn(_: FormState, formData: FormData): Promise<FormState> {
  const parsed = credentialsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: 'errInvalid' };
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: 'errCredentials' };
  redirect('/dashboard');
}

export async function signUp(_: FormState, formData: FormData): Promise<FormState> {
  const parsed = signUpSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: 'errInvalid' };
  const { email, password, fullName, mode, orgName } = parsed.data;
  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
      // Role is never taken from metadata; the DB trigger always makes the signer the owner of a new org.
      data: { full_name: fullName, mode, org_name: orgName },
    },
  });
  if (error) return { error: 'errSignUp' };
  return { ok: 'checkEmail' };
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
