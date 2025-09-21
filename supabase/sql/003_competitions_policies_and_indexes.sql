-- 003_competitions_policies_and_indexes.sql
-- Ensure competitions has proper RLS + read policies and helpful indexes

-- Enable RLS (if not already)
alter table public.competitions enable row level security;

-- Allow read for anon+authenticated (adjust if you want auth-only)
do $$ begin
  if not exists (
    select 1 from pg_policies where poltablename = 'competitions' and polname = 'read competitions (anon+auth)'
  ) then
    create policy "read competitions (anon+auth)"
      on public.competitions
      for select
      to anon, authenticated
      using (true);
  end if;
end $$;

-- Unique(url) is helpful for upsert
alter table public.competitions
  add constraint if not exists competitions_url_unique unique (url);

-- Trigram index for fast ILIKE searches
create extension if not exists pg_trgm;
create index if not exists competitions_prize_gin on public.competitions using gin (prize gin_trgm_ops);

-- Optional: simple btree indexes
create index if not exists idx_competitions_prize on public.competitions (prize);
create index if not exists idx_competitions_odds on public.competitions (odds);
