-- 002_seed_sites_and_rules.sql
-- Seed initial sites + adapter rules

insert into public.sites (name, list_url, link_selector, adapter_key, tier, enabled)
values
('Rev Comps','https://www.revcomps.com/current-competitions/','a[href*="/product/"]','revcomps','both', true),
('Dream Car Giveaways','https://dreamcargiveaways.co.uk/competitions','a[href*="/competitions/"]','generic','free', true)
on conflict (name) do update
  set list_url = excluded.list_url,
      link_selector = excluded.link_selector,
      adapter_key = excluded.adapter_key,
      tier = excluded.tier,
      enabled = excluded.enabled;

-- Generic rules: price window + basic total/sold regexes
insert into public.adapter_rules (adapter_key, rules)
values
('generic', jsonb_build_object(
  'price_patterns', jsonb_build_array('£\\s*([\\d.,]+)'),
  'price_window', jsonb_build_object('min',0.1,'max',50),
  'total_patterns', jsonb_build_array('Number of Tickets\\s*([\\d,]+)','max of\\s*([\\d,]+)\\s*tickets','([\\d,]+)\\s*entries'),
  'sold_patterns',  jsonb_build_array('Tickets?\\s*sold\\s*([\\d,]+)','Sold:\\s*([\\d,]+)')
))
on conflict (adapter_key) do update set rules = excluded.rules;

-- Rev Comps rules: explicit phrases first
insert into public.adapter_rules (adapter_key, rules)
values
('revcomps', jsonb_build_object(
  'priority_total', 'PRIZE HAS A MAX OF\\s*([\\d,]+)\\s*TICKETS',
  'remaining', 'REMAINING:\\s*([\\d,]+)',
  'sold', 'SOLD:\\s*([\\d,]+)',
  'fallback', jsonb_build_object(
     'total_patterns', jsonb_build_array('Number of Tickets\\s*([\\d,]+)','max of\\s*([\\d,]+)\\s*tickets','([\\d,]+)\\s*entries'),
     'sold_patterns',  jsonb_build_array('Tickets?\\s*sold\\s*([\\d,]+)','Sold:\\s*([\\d,]+)')
  )
))
on conflict (adapter_key) do update set rules = excluded.rules;
