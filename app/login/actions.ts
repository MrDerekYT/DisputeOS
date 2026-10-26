'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { credentialsSchema } from '@/lib/validation';

export async function signIn(_: { error?: string } | undefined, formData: FormData) {
  const parsed = credentialsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: 'Enter a valid email and a password of 8+ characters.' };
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: 'Invalid email or password.' };
  redirect('/dashboard');
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
