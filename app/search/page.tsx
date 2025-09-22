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
        setError('No active session. Please log in.');
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
        return;
      }

      if (!data || data.length === 0) {
        const res = await fetch('/api/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        });

        // Try to parse; tolerate empty body
        let freshData: unknown[] = [];
        const text = await res.text();
        if (text) {
          try { freshData = JSON.parse(text); } catch { /* ignore parse error */ }
        }

        if (!res.ok || freshData.length === 0) {
          setError('No competitions found after scraping. Try a different query.');
          return;
        }
      }

      router.push(`/results?query=${encodeURIComponent(query)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  // Use a form so Enter submits naturally anywhere in the input
  const onSubmit: React.FormEventHandler<HTMLFormElement> = (e) => {
    e.preventDefault();
    if (!loading && query.trim().length > 0) {
      void handleSearch();
    }
  };

  return (
    <div className="min-h-screen bg-midnight-blue text-wolf-grey flex flex-col items-center justify-center p-8">
      {/* Logo slightly larger; keep tight spacing */}
      <img src="/logo.png" alt="PrizeWolf Logo" className="mb-2 w-72 h-auto" />

      <form onSubmit={onSubmit} className="w-full max-w-md flex flex-col items-stretch">
        {error && <p className="text-neon-red mb-3">{error}</p>}

        <input
          type="text"
          placeholder="Hunt for Rolex, Audi, or Cash..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full p-3 border border-neon-red rounded-md bg-wolf-grey text-midnight-blue mb-3"
          aria-label="Search prizes"
        />

        <button
          type="submit"
          onClick={(e) => { /* still supports click */ }}
          disabled={loading || query.trim().length === 0}
          className="inline-flex items-center justify-center gap-2 bg-electric-gold text-midnight-blue font-bold py-2 px-6 rounded-md hover:bg-neon-red hover:text-white transition disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {loading && (
            <svg
              className="animate-spin h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4A4 4 0 008 12H4z"/>
            </svg>
          )}
          {loading ? 'Hunting...' : 'Find Prizes'}
        </button>
      </form>
    </div>
  );
}
