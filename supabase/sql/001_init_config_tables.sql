-- 001_init_config_tables.sql
-- Creates site_tier enum, sites + adapter_rules tables, enables RLS, and read policies

create type if not exists site_tier as enum ('free','premium','both');

create table if not exists public.sites (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  list_url text not null,
  link_selector text not null,
  adapter_key text not null,
  enabled boolean not null default true,
  tier site_tier not null default 'both',
  rate_limit_ms int not null default 250,
  last_success_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.adapter_rules (
  adapter_key text primary key,
  rules jsonb not null,
  updated_at timestamptz not null default now()
);

-- Enable RLS (so it doesn't say "Unrestricted")
alter table public.sites enable row level security;
alter table public.adapter_rules enable row level security;

-- Policies: allow read for anon/auth only when enabled (sites)
do $$ begin
  if not exists (
    select 1 from pg_policies where poltablename = 'sites' and polname = 'read sites (anon+auth, enabled only)'
  ) then
    create policy "read sites (anon+auth, enabled only)"
      on public.sites
      for select
      to anon, authenticated
      using (enabled = true);
  end if;
end $$;

-- Policies: allow read for adapter_rules to anon/auth
do $$ begin
  if not exists (
    select 1 from pg_policies where poltablename = 'adapter_rules' and polname = 'read adapter_rules (anon+auth)'
  ) then
    create policy "read adapter_rules (anon+auth)"
      on public.adapter_rules
      for select
      to anon, authenticated
      using (true);
  end if;
end $$;
