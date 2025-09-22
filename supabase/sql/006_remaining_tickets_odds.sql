-- 1) Add remaining_tickets as a STORED generated column
alter table public.competitions
  add column if not exists remaining_tickets int
  generated always as (
    case
      when total_tickets is null then null
      else greatest(total_tickets - coalesce(tickets_sold, 0), 0)
    end
  ) stored;

-- 2) Helpful index for sorting/filtering by remaining
create index if not exists idx_remaining_tickets
  on public.competitions (remaining_tickets);
