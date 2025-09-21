-- 005_user_features.sql
-- Future tables for user-specific features (mark as entered, email digests)

-- Track which competitions a user has entered/marked
create table if not exists public.user_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  competition_id uuid not null references public.competitions(id) on delete cascade,
  marked_at timestamptz not null default now(),
  constraint user_entries_unique unique (user_id, competition_id)
);

-- Track user preferences for email digests/alerts
create table if not exists public.user_digest_prefs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  frequency text check (frequency in ('daily','weekly','monthly')) not null default 'weekly',
  keywords text[],                -- e.g. ['rolex','audi']
  include_low_odds boolean not null default true,
  include_new boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS
alter table public.user_entries enable row level security;
alter table public.user_digest_prefs enable row level security;

-- Policies: users can only read/write their own records
create policy "users can manage their own entries"
  on public.user_entries
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "users can manage their own digest prefs"
  on public.user_digest_prefs
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
