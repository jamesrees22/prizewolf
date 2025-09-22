// app/api/scrape/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { load, type CheerioAPI } from 'cheerio';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_KEY as string
);

type Row = {
  prize: string;
  site_name: string;
  entry_fee: number | null;
  total_tickets: number | null;
  tickets_sold: number | null;
  remaining_tickets?: number | null;
  odds?: number | null;
  url: string;
  scraped_at?: string;
};

type AdapterRules = {
  adapter_key: string;
  rules: any;
};

type SiteCfg = {
  id: string;
  name: string;
  list_url: string;
  link_selector: string;
  adapter_key: string; // 'revcomps' | 'dcg' | 'generic' | future keys
  rate_limit_ms: number | null;
  tier: 'free' | 'premium' | 'both';
  enabled: boolean;
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const fetchHtml = async (url: string): Promise<string> => {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-GB,en;q=0.9' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
};

// ---------- helpers ----------
const toFloat = (s?: string | null): number | null => {
  if (!s) return null;
  const n = parseFloat(s.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const toInt = (s?: string | null): number | null => {
  if (!s) return null;
  const n = parseInt(s.replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

const computeRemaining = (total?: number | null, sold?: number | null) => {
  if (total == null || sold == null) return null;
  const r = total - sold;
  return r >= 0 ? r : null;
};

const parsePrice = ($: CheerioAPI, rules?: any) => {
  // Try rule-based selectors first
  const priceSelectors: string[] = rules?.price_selectors ?? [];
  for (const sel of priceSelectors) {
    const text = $(sel).first().text();
    const n = toFloat(text);
    if (n != null) return n;
  }
  // Fallback: pick plausible £ values in body text
  const body = $('body').text();
  const matches = body.match(/\b£?\s?(\d+(?:\.\d{1,2})?)\b/g) || [];
  const nums = matches
    .map((m) => toFloat(m))
    .filter((n): n is number => n != null);
  if (nums.length === 0) return null;

  const min = rules?.price_window?.min ?? 0.1;
  const max = rules?.price_window?.max ?? 50;
  const plausible = nums.filter((v) => v >= min && v <= max);
  if (plausible.length === 0) return null;
  return Math.min(...plausible);
};

// Generic totals extractor; accepts optional rule arrays
const extractTotalsGeneric = ($: CheerioAPI, rules?: any) => {
  const text = $('body').text();

  const totalPatterns: RegExp[] = (rules?.total_patterns ?? [
    'Number of Tickets\\s*([\\d,]+)',
    'Max Tickets\\s*([\\d,]+)',
    'Maximum Tickets\\s*([\\d,]+)',
    'Tickets Available\\s*([\\d,]+)\\s*/\\s*([\\d,]+)',
  ]).map((p: string) => new RegExp(p, 'i'));

  const soldPatterns: RegExp[] = (rules?.sold_patterns ?? [
    '\\bSold\\s*:\\s*([\\d,]+)\\b',
    '\\b([\\d,]+)\\s*sold\\b',
  ]).map((p: string) => new RegExp(p, 'i'));

  let total: number | null = null;
  let sold: number | null = null;

  for (const re of totalPatterns) {
    const m = text.match(re);
    if (m) {
      total = toInt(m[2] ?? m[1]);
      if (m[2]) sold = toInt(m[1]); // when pattern includes sold/total
      break;
    }
  }

  if (sold == null) {
    for (const re of soldPatterns) {
      const m = text.match(re);
      if (m) {
        sold = toInt(m[1]);
        break;
      }
    }
  }

  if (total != null && sold != null && sold > total) sold = null;
  return { total, sold };
};

// Rev Comps — prefer explicit MAX + SOLD/REMAINING, then fallback
const extractTotalsRevComps = ($: CheerioAPI, rules?: any) => {
  const text = $('body').text();

  const maxPhrase = toInt(text.match(/\bPRIZE HAS A MAX OF\s*([\d,]+)\s*TICKETS\b/i)?.[1]);
  let sold = toInt(text.match(/\bSOLD:\s*([\d,]+)/i)?.[1]) ?? null;
  const remaining = toInt(text.match(/\bREMAINING:\s*([\d,]+)/i)?.[1]) ?? null;

  let total = maxPhrase ?? null;
  if (total == null && sold != null && remaining != null) total = sold + remaining;
  if (total != null && sold != null && sold > total) sold = null;

  if (total == null) {
    const g = extractTotalsGeneric($, rules?.fallback);
    total = g.total;
    if (sold == null) sold = g.sold;
  }
  return { total, sold };
};

// Dream Car Giveaways — prefer Remaining/Sold/Max entries; avoid stray numbers
const extractTotalsDCG = ($: CheerioAPI) => {
  const text = $('body').text();

  const remaining = toInt(text.match(/\bremaining:\s*([\d,]+)\b/i)?.[1]) ?? null;
  const sold = toInt(text.match(/\bsold:\s*([\d,]+)\b/i)?.[1]) ?? null;

  let total = toInt(text.match(/\bmax(?:imum)?\s*tickets?:?\s*([\d,]+)\b/i)?.[1]) ?? null;
  if (total == null && sold != null && remaining != null) total = sold + remaining;
  if (total != null && sold != null && sold > total) return { total, sold: null };

  if (total == null) {
    const g = extractTotalsGeneric($);
    total = g.total;
  }
  return { total, sold };
};

const buildParser = (adapter_key: string, rules?: any) => {
  return (html: string, url: string, siteName: string): Row | null => {
    const $ = load(html);

    // Prize (rules or common selectors)
    const prize =
      $(rules?.prize_selectors?.join(',') ?? '').first().text().trim() ||
      $('h1, h2.product_title, .woocommerce-loop-product__title').first().text().trim() ||
      $('[class*="prize"]').first().text().trim();

    if (!prize) return null;

    // Price
    const entry_fee =
      parsePrice($, rules) ??
      toFloat($('.price').first().text()) ??
      toFloat($('[class*="price"]').first().text());

    // Totals
    let totals: { total: number | null; sold: number | null };
    switch (adapter_key) {
      case 'revcomps':
        totals = extractTotalsRevComps($, rules);
        break;
      case 'dcg':
        totals = extractTotalsDCG($);
        break;
      case 'generic':
      default:
        totals = extractTotalsGeneric($, rules);
        break;
    }

    return {
      prize,
      site_name: siteName,
      entry_fee,
      total_tickets: totals.total,
      tickets_sold: totals.sold,
      url,
    };
  };
};

export async function POST(req: NextRequest) {
  try {
    // request body: { query?: string, tier?: 'free'|'premium'|'both' }
    const body = await req.json().catch(() => ({} as any));
    const query: string = String(body?.query ?? '');
    const userTier: 'free' | 'premium' | 'both' = (body?.tier ?? 'both');

    // Load enabled sites (respect tier)
    const { data: sitesData, error: sitesErr } = await supabase
      .from('sites')
      .select('id,name,list_url,link_selector,adapter_key,rate_limit_ms,tier,enabled')
      .eq('enabled', true);

    if (sitesErr) throw sitesErr;

    const siteRows: SiteCfg[] =
      (sitesData ?? []).filter((s: SiteCfg) =>
        userTier === 'both' ? true : (s.tier === 'both' || s.tier === userTier)
      );

    if (siteRows.length === 0) {
      return NextResponse.json([], { status: 200 });
    }

    // Load adapter rules (still used by 'generic' and fallbacks)
    const { data: rulesData, error: rulesErr } = await supabase
      .from('adapter_rules')
      .select('adapter_key,rules');

    if (rulesErr) throw rulesErr;

    const rulesMap = new Map<string, any>();
    (rulesData ?? []).forEach((r: AdapterRules) => rulesMap.set(r.adapter_key, r.rules));

    const apiRows: Row[] = [];
    const upsertRows: Row[] = [];
    const seen = new Set<string>();

    // Process each site with its own scrape_run
    for (const site of siteRows) {
      // 1) Create the run (started)
      const { data: runStart } = await supabase
        .from('scrape_runs')
        .insert({ site_id: site.id, status: 'started' })
        .select('id')
        .single();

      const runId = runStart?.id as number | undefined;

      // Keep track of per-site upserts
      const upsertsBefore = upsertRows.length;

      try {
        // 2) Scrape list page
        const listHtml = await fetchHtml(site.list_url);
        const $ = load(listHtml);

        const links = Array.from(
          new Set(
            $(site.link_selector)
              .map((_, a) => $(a).attr('href'))
              .get()
              .filter(Boolean)
              .map((href) => new URL(href!, site.list_url).href)
          )
        ).slice(0, 60);

        const parseDetail = buildParser(site.adapter_key, rulesMap.get(site.adapter_key));

        for (const url of links) {
          if (seen.has(url)) continue;
          seen.add(url);

          try {
            const detailHtml = await fetchHtml(url);
            const parsed = parseDetail(detailHtml, url, site.name);
            if (!parsed) continue;

            if (query && !parsed.prize.toLowerCase().includes(query.toLowerCase())) {
              continue;
            }

            const scraped_at = new Date().toISOString();
            const remaining_tickets = computeRemaining(parsed.total_tickets, parsed.tickets_sold);
            const odds = parsed.total_tickets ?? null;

            const row: Row = {
              ...parsed,
              scraped_at,
              remaining_tickets,
              odds,
            };

            upsertRows.push(row);
            apiRows.push(row);

            if (site.rate_limit_ms) {
              await new Promise((res) => setTimeout(res, site.rate_limit_ms!));
            }
          } catch {
            // Skip bad detail pages, continue with other links
            continue;
          }
        }

        // 3) Upsert (global, but we'll count how many this site contributed)
        if (upsertRows.length > upsertsBefore) {
          const { error } = await supabase
            .from('competitions')
            .upsert(upsertRows, { onConflict: 'url', ignoreDuplicates: false })
            .select();
          if (error) {
            console.error('Supabase upsert error:', error);
            // Mark this site's run as error
            if (runId) {
              await supabase
                .from('scrape_runs')
                .update({
                  status: 'error',
                  finished_at: new Date().toISOString(),
                  error: error.message,
                })
                .eq('id', runId);
            }
            // Continue to next site rather than failing entire request
            continue;
          }
        }

        // 4) Mark run ok
        const siteCount = upsertRows.length - upsertsBefore;
        if (runId) {
          await supabase
            .from('scrape_runs')
            .update({
              status: 'ok',
              items_ingested: siteCount,
              finished_at: new Date().toISOString(),
            })
            .eq('id', runId);
        }
      } catch (siteErr: any) {
        // Mark this site's run as error
        if (runId) {
          await supabase
            .from('scrape_runs')
            .update({
              status: 'error',
              finished_at: new Date().toISOString(),
              error: String(siteErr?.message ?? siteErr),
            })
            .eq('id', runId);
        }
        // Continue with other sites
        continue;
      }
    }

    // If anything was found, return it
    return NextResponse.json(apiRows, { status: 200 });
  } catch (err: any) {
    console.error('Scrape route error:', err);
    return NextResponse.json({ error: err?.message ?? 'Unknown error' }, { status: 500 });
  }
}
