-- 004_adjust_nullability_and_odds.sql
-- Make numeric fields nullable (scraper may not always find values)
alter table public.competitions
  alter column entry_fee drop not null,
  alter column total_tickets drop not null,
  alter column tickets_sold drop not null,
  alter column entry_fee drop default,
  alter column total_tickets drop default,
  alter column tickets_sold drop default;

-- Re-create odds as remaining tickets (1 in N remaining)
alter table public.competitions drop column if exists odds;
alter table public.competitions
  add column odds numeric GENERATED ALWAYS AS (
    case
      when total_tickets is null then null::numeric
      when total_tickets <= 0 then null::numeric
      else GREATEST(total_tickets - COALESCE(tickets_sold, 0), 0)
    end
  ) STORED;
