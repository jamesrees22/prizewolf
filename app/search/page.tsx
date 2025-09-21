'use client';
import { useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useRouter } from 'next/navigation';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSearch = async () => {
    setLoading(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      router.push('/auth');
      return;
    }

    const tier = session?.user?.user_metadata?.subscription_tier || 'free';
    const { data, error } = await supabase
      .from('competitions')
      .select('*')
      .ilike('prize', `%${query}%`)
      .order('odds', { ascending: true })
      .limit(tier === 'paid' ? 50 : 10);

    if (error) {
      console.error(error);
      setLoading(false);
      return;
    }

    if (data?.length === 0) {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const freshData = await res.json();
      router.push(`/results?query=${encodeURIComponent(query)}`);
    } else {
      router.push(`/results?query=${encodeURIComponent(query)}`);
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-midnight-blue text-wolf-grey flex flex-col items-center justify-center p-8">
      <h1 className="text-4xl font-bold text-electric-gold mb-8">PrizeWolf</h1>
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