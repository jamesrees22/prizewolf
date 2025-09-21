'use client';
import { useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useRouter } from 'next/navigation';
import type { Session } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Supabase environment variables are not configured. Check Codespaces secrets.');
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const handleSearch = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession() as { data: { session: Session | null } };
      if (!session) {
        router.push('/auth');
        return;
      }

      const tier = session?.user?.user_metadata?.subscription_tier || 'free';
      const { data, error: queryError } = await supabase
        .from('competitions')
        .select('*')
        .ilike('prize', `%${query}%`)
        .order('odds', { ascending: true })
        .limit(tier === 'paid' ? 50 : 10);

      if (queryError) {
        setError(queryError.message);
        setLoading(false);
        return;
      }

      if (data?.length === 0) {
        const res = await fetch('/api/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        });
        if (!res.ok) throw new Error('Scrape request failed');
        const freshData = await res.json();
        router.push(`/results?query=${encodeURIComponent(query)}`);
      } else {
        router.push(`/results?query=${encodeURIComponent(query)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-midnight-blue text-wolf-grey flex flex-col items-center justify-center p-8">
      <img src="/logo.png" alt="PrizeWolf Logo" className="mb-8 w-48 h-auto" />
      {error && <p className="text-neon-red mb-4">{error}</p>}
      <input
        type="text"
        placeholder="Hunt for Rolex, Audi, or Cash..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full max-w-md p-3 border border-neon-red rounded-md bg-wolf-grey text-midnight-blue mb-4"
      />
      <button
        onClick={handleSearch}
        disabled={loading}
        className="bg-electric-gold text-midnight-blue font-bold py-2 px-6 rounded-md hover:bg-neon-red hover:text-white transition"
      >
        {loading ? 'Hunting...' : 'Find Prizes'}
      </button>
    </div>
  );
}