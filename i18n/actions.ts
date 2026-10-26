'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { LOCALES } from './config';

export async function setLocale(formData: FormData) {
  const v = String(formData.get('locale'));
  if (!(LOCALES as readonly string[]).includes(v)) return;
  (await cookies()).set('locale', v, {
    path: '/',
    maxAge: 31_536_000,
    sameSite: 'lax',
    secure: true,
  });
  revalidatePath('/', 'layout');
}
