'use client';
import { useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useRouter } from 'next/navigation';

export const dynamic = 'force-dynamic'; // ✅ prevents Next.js from pre-rendering this page

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// ✅ Don’t throw at build time — just handle missing keys gracefully
let supabase: ReturnType<typeof createClient> | null = null;
if (typeof window !== 'undefined' && supabaseUrl && supabaseAnonKey) {
  supabase = createClient(supabaseUrl, supabaseAnonKey);
}

export default function AuthPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!supabase) {
      setError('Supabase client not available. Please check environment config.');
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      setError(error.message);
    } else {
      router.push('/search');
    }
  };

  return (
    <div className="min-h-screen bg-midnight-blue text-wolf-grey flex items-center justify-center p-8">
      <div className="w-full max-w-md">
        <h1 className="text-3xl font-bold text-electric-gold mb-6">Login to PrizeWolf</h1>
        {error && <p className="text-neon-red mb-4">{error}</p>}
        <form onSubmit={handleLogin} className="space-y-4">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full p-3 border border-neon-red rounded-md bg-wolf-grey text-midnight-blue"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full p-3 border border-neon-red rounded-md bg-wolf-grey text-midnight-blue"
          />
          <button
            type="submit"
            className="w-full bg-electric-gold text-midnight-blue font-bold py-2 px-6 rounded-md hover:bg-neon-red hover:text-white transition"
          >
            Log In
          </button>
        </form>
      </div>
    </div>
  );
}
