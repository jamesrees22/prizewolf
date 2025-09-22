'use client';
import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Session } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

type UUID = string;

interface Competition {
  id: UUID;
  prize: string;
  site_name: string;
  entry_fee: number | null;
  total_tickets: number | null;
  tickets_sold: number | null;
  remaining_tickets: number | null; // <-- NEW from DB generated column
  odds: number | null;              // "1 in N" (we treat as remaining N for formatting)
  url: string;
  scraped_at: string | null;
}

type SortOption = 'odds_asc' | 'odds_desc' | 'entry_fee_asc' | 'entry_fee_desc';

export default function ResultsPage() {
  const [results, setResults] = useState<Competition[]>([]);
  const [loading, setLoading] = useState(true);
  const [marking, setMarking] = useState<Record<UUID, boolean>>({});
  const [markedIds, setMarkedIds] = useState<Set<UUID>>(new Set());
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sort, setSort] = useState<SortOption>('odds_asc');

  const searchParams = useSearchParams();
  const query = searchParams.get('query') || '';
  const router = useRouter();

  // helpers
  const fmtInt = (n: number | null | undefined) =>
    n == null ? 'N/A' : n.toLocaleString('en-GB');

  const fmtMoney = (n: number | null | undefined) =>
    n == null ? 'N/A' : `£${n.toFixed(2)}`;

  const fmtOdds = (n: number | null | undefined) =>
    n == null ? 'N/A' : `1 in ${n.toLocaleString('en-GB')}`;

  useEffect(() => {
    const fetchResults = async () => {
      setLoading(true);
      setErrorMsg(null);

      const { data: { session } } = await supabase.auth.getSession() as { data: { session: Session | null } };
      const tier = session?.user?.user_metadata?.subscription_tier || 'free';

      // Decide order column + direction
      const [col, dir] =
        sort === 'odds_asc' ? ['odds', true] :
        sort === 'odds_desc' ? ['odds', false] :
        sort === 'entry_fee_asc' ? ['entry_fee', true] :
        ['entry_fee', false] as const;

      const { data, error } = await supabase
        .from('competitions')
        .select('*')
        .ilike('prize', `%${query}%`)
        .order(col, { ascending: dir, nullsFirst: true }) // keep nulls grouped
        .order('prize', { ascending: true }) // stable secondary order
        .limit(tier === 'paid' ? 50 : 10);

      if (error) {
        console.error('Supabase SELECT error:', error);
        setResults([]);
        setErrorMsg('Could not load results.');
      } else {
        setResults((data as Competition[]) || []);
      }
      setLoading(false);
    };

    fetchResults();
  }, [query, sort]);

  // After results load, fetch which of these have been marked by the current user
  useEffect(() => {
    const preloadMarked = async () => {
      if (results.length === 0) {
        setMarkedIds(new Set());
        return;
      }
      const { data: { session } } = await supabase.auth.getSession() as { data: { session: Session | null } };
      if (!session) {
        setMarkedIds(new Set());
        return;
      }
      const compIds = results.map(r => r.id);
      const { data, error } = await supabase
        .from('user_entries')
        .select('competition_id')
        .in('competition_id', compIds);

      if (!error && data) {
        setMarkedIds(new Set(data.map(d => d.competition_id as UUID)));
      }
    };
    preloadMarked();
  }, [results]);

  const handleMarkEntered = async (competitionId: UUID) => {
    setErrorMsg(null);
    setMarking(prev => ({ ...prev, [competitionId]: true }));

    try {
      const { data: { session } } = await supabase.auth.getSession() as { data: { session: Session | null } };
      if (!session) {
        router.push('/auth');
        return;
      }

      const user_id = session.user.id as UUID;

      const { error } = await supabase
        .from('user_entries')
        .insert([{ user_id, competition_id: competitionId }]);

      if (error) {
        // 23505 = unique_violation (already marked)
        if ((error as any).code === '23505') {
          setMarkedIds(prev => new Set(prev).add(competitionId));
        } else {
          console.error('Error marking entry:', error);
          setErrorMsg('Could not mark this entry. Please try again.');
        }
      } else {
        setMarkedIds(prev => new Set(prev).add(competitionId));
      }
    } finally {
      setMarking(prev => ({ ...prev, [competitionId]: false }));
    }
  };

  const rows = useMemo(() => results, [results]);

  return (
    <div className="min-h-screen bg-midnight-blue text-wolf-grey p-8">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <h1 className="text-3xl font-bold text-electric-gold">
          Results for "{query}"
        </h1>

        {/* Sort control */}
        <div className="flex items-center gap-2">
          <label htmlFor="sort" className="text-sm">Sort by:</label>
          <select
            id="sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortOption)}
            className="rounded-md bg-wolf-grey text-midnight-blue px-3 py-2 border border-wolf-grey/60"
          >
            <option value="odds_asc">Odds (best first)</option>
            <option value="odds_desc">Odds (worst first)</option>
            <option value="entry_fee_asc">Entry fee (low → high)</option>
            <option value="entry_fee_desc">Entry fee (high → low)</option>
          </select>
        </div>
      </div>

      {errorMsg && <p className="mb-4 text-neon-red">{errorMsg}</p>}

      {loading ? (
        <p>Loading...</p>
      ) : rows.length === 0 ? (
        <p className="text-neon-red">No competitions found. Try another prize!</p>
      ) : (
        <table className="w-full border-collapse border border-wolf-grey">
          <thead>
            <tr className="bg-electric-gold text-midnight-blue">
              <th className="p-2 text-left">Prize</th>
              <th className="p-2 text-left">Site</th>
              <th className="p-2 text-right">Odds</th>
              <th className="p-2 text-right">Remaining</th>
              <th className="p-2 text-right">Entry Fee</th>
              <th className="p-2 text-center">Link</th>
              <th className="p-2 text-center">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((comp) => {
              const isMarked = markedIds.has(comp.id);
              const isBusy = !!marking[comp.id];

              return (
                <tr key={comp.id} className="border-b border-wolf-grey hover:bg-neon-red hover:text-white">
                  <td className="p-2">{comp.prize}</td>
                  <td className="p-2">{comp.site_name}</td>
                  <td className="p-2 text-right">{fmtOdds(comp.odds)}</td>
                  <td className="p-2 text-right">{fmtInt(comp.remaining_tickets)}</td>
                  <td className="p-2 text-right">{fmtMoney(comp.entry_fee ?? null)}</td>
                  <td className="p-2 text-center">
                    <a href={comp.url} target="_blank" className="underline">Enter</a>
                  </td>
                  <td className="p-2 text-center">
                    <button
                      onClick={() => handleMarkEntered(comp.id)}
                      disabled={isMarked || isBusy}
                      className={`px-3 py-1 rounded-md border transition ${
                        isMarked
                          ? 'bg-wolf-grey text-midnight-blue cursor-not-allowed'
                          : 'bg-electric-gold text-midnight-blue hover:bg-white'
                      }`}
                      title={isMarked ? 'Already marked as entered' : 'Mark as entered'}
                    >
                      {isMarked ? 'Entered ✓' : isBusy ? 'Marking…' : 'Mark Entered'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
