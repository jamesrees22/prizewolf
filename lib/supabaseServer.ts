// lib/supabaseServer.ts
import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

export function supabaseServer() {
  // In some Next versions/types, cookies() is typed as Promise in edge runtime.
  // We cast to any to keep it runtime-compatible for nodejs runtime.
  const cookieStore = cookies() as any;

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get?.(name)?.value;
        },
        set(name: string, value: string, options?: CookieOptions) {
          try {
            cookieStore.set?.({ name, value, ...options });
          } catch {
            // no-op on edge/static where setting is disallowed
          }
        },
        remove(name: string, options?: CookieOptions) {
          try {
            cookieStore.set?.({ name, value: '', ...options, maxAge: 0 });
          } catch {
            // no-op on edge/static where setting is disallowed
          }
        },
      },
    }
  );
}
