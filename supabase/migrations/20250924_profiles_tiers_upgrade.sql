-- 1) ENUM for tiers
do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_tier') then
    create type user_tier as enum ('free', 'premium', 'admin');
  end if;
end$$;

-- 2) Add new columns if missing
alter table public.profiles
  add column if not exists tier user_tier,
  add column if not exists display_name text,
  add column if not exists stripe_customer_id text,
  add column if not exists created_at timestamptz not null default now();

-- Ensure updated_at exists & is not null
update public.profiles set updated_at = now() where updated_at is null;

-- 3) Migrate old text -> enum (default to 'free' when unknown/empty)
update public.profiles
set tier = case
  when subscription_tier is null then 'free'::user_tier
  when lower(subscription_tier) = 'premium' then 'premium'::user_tier
  when lower(subscription_tier) = 'admin' then 'admin'::user_tier
  else 'free'::user_tier
end
where tier is null;

-- 4) (Optional) drop legacy column
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'subscription_tier'
  ) then
    alter table public.profiles drop column subscription_tier;
  end if;
end$$;

-- 5) Ensure primary key on id (FK already exists per your check)
do $$
begin
  if not exists (
    select 1 from pg_index i
    join pg_class c on c.oid = i.indrelid
    where c.relname = 'profiles' and i.indisprimary
  ) then
    alter table public.profiles add primary key (id);
  end if;
end$$;

-- 6) updated_at trigger
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

-- 7) Create profile row on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.profiles (id, tier)
  values (new.id, 'free')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_on_auth_user_created on auth.users;
create trigger trg_on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- 8) RLS
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
on public.profiles
for select
using (auth.uid() = id);

drop policy if exists "profiles_update_self_no_tier_change" on public.profiles;
create policy "profiles_update_self_no_tier_change"
on public.profiles
for update
using (auth.uid() = id)
with check (
  auth.uid() = id
  and (case when new.tier is distinct from old.tier then false else true end)
);

-- 9) Handy view
create or replace view public.my_profile as
select *
from public.profiles
where id = auth.uid();
