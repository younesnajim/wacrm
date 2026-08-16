'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { isSupportedLocale, LOCALE_COOKIE, type Locale } from './locale';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export async function setLocale(locale: Locale): Promise<void> {
  if (!isSupportedLocale(locale)) return;

  const cookieStore = await cookies();
  cookieStore.set(LOCALE_COOKIE, locale, {
    httpOnly: false,
    maxAge: ONE_YEAR_SECONDS,
    path: '/',
  });

  // Locale drives <html lang/dir>, the font, and every message in the
  // tree from the root layout down — revalidate the whole thing rather
  // than a single route.
  revalidatePath('/', 'layout');
}
