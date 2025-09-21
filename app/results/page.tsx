'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useSearchParams } from 'next/navigation';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function ResultsPage() {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const searchParams = useSearchParams();
  const query = searchParams.get('query') || '';

  useEffect(() => {
    const fetchResults = async () => {
      setLoading(true);
      const { data: { session } } = await supabase.auth.getSession();
      const tier = session?.user?.user_metadata?.subscription_tier || 'free';

      const { data } = await supabase
        .from('competitions')
        .select('*')
        .ilike('prize', `%${query}%`)
        .order('odds', { ascending: true })
        .limit(tier === 'paid' ? 50 : 10);

      setResults(data || []);
      setLoading(false);
    };
    fetchResults();
  }, [query]);

  return (
    <div className="min-h-screen bg-midnight-blue text-wolf-grey p-8">
      <h1 className="text-3xl font-bold text-electric-gold mb-6">Results for "{query}"</h1>
      {loading ? (
        <p>Loading...</p>
      ) : results.length === 0 ? (
        <p className="text-neon-red">No competitions found. Try another prize!</p>
      ) : (
        <table className="w-full border-collapse border border-wolf-grey">
          <thead>
            <tr className="bg-electric-gold text-midnight-blue">
              <th className="p-2">Prize</th>
              <th className="p-2">Site</th>
              <th className="p-2">Odds (1 in)</th>
              <th className="p-2">Entry Fee</th>
              <th className="p-2">Link</th>
            </tr>
          </thead>
          <tbody>
            {results.map((comp: any) => (
              <tr key={comp.id} className="border-b border-wolf-grey hover:bg-neon-red hover:text-white">
                <td className="p-2">{comp.prize}</td>
                <td className="p-2">{comp.site_name}</td>
                <td className="p-2">{comp.odds?.toFixed(0) || 'N/A'}</td>
                <td className="p-2">£{comp.entry_fee}</td>
                <td className="p-2">
                  <a href={comp.url} target="_blank" className="underline">Enter</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}