// app/api/scrape/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { load, type CheerioAPI } from 'cheerio';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_KEY as string
);

// ---------- types ----------
type ApiRow = {
  prize: string;
  site_name: string;
  entry_fee: number | null;
  total_tickets: number | null;
  tickets_sold: number | null;
  remaining_tickets?: number | null; // computed/returned
  odds?: number | null;              // computed/returned only
  url: string;
  scraped_at?: string;
};

// DB payload — exclude generated cols like `odds` and `remaining_tickets`
type DbRow = {
  prize: string;
  site_name: string;
  entry_fee: number | null;
  total_tickets: number | null;
  tickets_sold: number | null;
  url: string;
  scraped_at?: string;
};

type AdapterRules = { adapter_key: string; rules: any };

type SiteCfg = {
  id: string;
  name: string;
  list_url: string;
  link_selector: string;
  adapter_key: string; // 'revcomps' | 'dcg' | 'generic'
  rate_limit_ms: number | null;
  tier: 'free' | 'premium' | 'both';
  enabled: boolean;
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// ---------- fetch helper ----------
const fetchHtml = async (url: string): Promise<string> => {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-GB,en;q=0.9' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
};

// ---------- utils ----------
const sleep = (ms?: number | null) =>
  ms && ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

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

// --- JSON-LD Product reader for precise name/price ---
const readJsonLdProduct = ($: CheerioAPI): { name?: string; price?: number | null } => {
  const blocks = $('script[type="application/ld+json"]')
    .map((_, el) => $(el).contents().text())
    .get();

  for (const raw of blocks) {
    try {
      const data = JSON.parse(raw);
      const arr = Array.isArray(data) ? data : [data];
      for (const node of arr) {
        const graph = Array.isArray(node?.['@graph']) ? node['@graph'] : [node];
        for (const g of graph) {
          const typeArr = g?.['@type']
            ? (Array.isArray(g['@type']) ? g['@type'] : [g['@type']])
            : [];
          if (typeArr.includes('Product')) {
            const offers = Array.isArray(g.offers) ? g.offers[0] : g.offers;
            const price = offers?.price ? Number(String(offers.price).replace(/[^\d.]/g, '')) : null;
            const name = typeof g.name === 'string' ? g.name.trim() : undefined;
            if (name || price != null) return { name, price: price ?? null };
          }
        }
      }
    } catch {
      // ignore malformed blocks
    }
  }
  return {};
};

// Price fallback when JSON-LD missing
const parsePrice = ($: CheerioAPI, rules?: any) => {
  const priceSelectors: string[] = rules?.price_selectors ?? [];
  for (const sel of priceSelectors) {
    const text = $(sel).first().text();
    const n = toFloat(text);
    if (n != null) return n;
  }
  // WooCommerce common nodes
  const wc =
    toFloat($('.price .amount').first().text()) ??
    toFloat($('.woocommerce-Price-amount').first().text());
  if (wc != null) return wc;

  // Last-resort text scan (bounded window)
  const body = $('body').text();
  const matches = body.match(/\b£?\s?(\d+(?:\.\d{1,2})?)\b/g) || [];
  const nums = matches.map((m) => toFloat(m)).filter((n): n is number => n != null);
  if (nums.length === 0) return null;

  const min = rules?.price_window?.min ?? 0.1;
  const max = rules?.price_window?.max ?? 50;
  const plausible = nums.filter((v) => v >= min && v <= max);
  if (plausible.length === 0) return null;
  return Math.min(...plausible);
};

// ---------- totals extractors ----------
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
      if (m[2]) sold = toInt(m[1]); // sold/total variant
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

// Broadened Dream Car Giveaways extractor
const extractTotalsDCG = ($: CheerioAPI) => {
  const text = $('body').text();

  const remaining =
    toInt(text.match(/\bentries?\s*remaining:\s*([\d,]+)\b/i)?.[1]) ??
    toInt(text.match(/\btickets?\s*remaining:\s*([\d,]+)\b/i)?.[1]) ??
    toInt(text.match(/\bremaining\s*entries?:\s*([\d,]+)\b/i)?.[1]) ??
    toInt(text.match(/\bremaining:\s*([\d,]+)\b/i)?.[1]) ??
    null;

  let sold =
    toInt(text.match(/\bentries?\s*sold:\s*([\d,]+)\b/i)?.[1]) ??
    toInt(text.match(/\btickets?\s*sold:\s*([\d,]+)\b/i)?.[1]) ??
    toInt(text.match(/\b([\d,]+)\s*sold\b/i)?.[1]) ??
    null;

  let total =
    toInt(text.match(/\bmax(?:imum)?\s*(?:entries|tickets)?:?\s*([\d,]+)\b/i)?.[1]) ??
    toInt(text.match(/\btotal\s*(?:entries|tickets)?:?\s*([\d,]+)\b/i)?.[1]) ??
    null;

  if (total == null && sold != null && remaining != null) total = sold + remaining;
  if (total != null && sold != null && sold > total) sold = null;

  if (total == null) {
    const g = extractTotalsGeneric($);
    total = g.total;
    if (sold == null) sold = g.sold;
  }
  return { total, sold };
};

// ---------- parser factory ----------
const buildParser = (adapter_key: string, rules?: any) => {
  return (html: string, url: string, siteName: string): ApiRow | null => {
    const $ = load(html);

    const ld = readJsonLdProduct($);

    const prize =
      ld.name ||
      $(rules?.prize_selectors?.join(',') ?? '').first().text().trim() ||
      $('h1, h2.product_title, .woocommerce-loop-product__title').first().text().trim() ||
      $('[class*="prize"]').first().text().trim() ||
      $('meta[property="og:title"]').attr('content')?.trim() ||
      $('title').text().trim();

    if (!prize) return null;

    const entry_fee =
      (ld.price != null ? ld.price : null) ||
      parsePrice($, rules) ||
      toFloat($('.price .amount').first().text()) ||
      toFloat($('.woocommerce-Price-amount').first().text()) ||
      toFloat($('.price').first().text()) ||
      toFloat($('[class*="price"]').first().text());

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

// ---------- site loader with fallback + logging ----------
async function loadSites(userTier: 'free' | 'premium' | 'both') {
  const baseSel = 'id,name,list_url,link_selector,adapter_key,rate_limit_ms,tier,enabled';

  // Primary: enabled=true
  let { data, error } = await supabase
    .from('sites')
    .select(baseSel)
    .eq('enabled', true);

  if (error) throw error;
  let rows = (data ?? []) as SiteCfg[];

  // Fallback: all sites
  if (!rows.length) {
    const retry = await supabase.from('sites').select(baseSel);
    if (retry.error) throw retry.error;
    rows = (retry.data ?? []) as SiteCfg[];
    console.warn('[scrape] No sites with enabled=true; falling back to all sites. Count:', rows.length);
  }

  // Tier filter
  const filtered = rows.filter((s) =>
    userTier === 'both' ? true : (s.tier === 'both' || s.tier === userTier)
  );

  console.log('[scrape] sites loaded:', {
    total: rows.length,
    filtered: filtered.length,
    names: filtered.map((s) => s.name),
  });

  return filtered;
}

// ---------- HTTP handler ----------
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const query: string = String(body?.query ?? '');
    const userTier: 'free' | 'premium' | 'both' = body?.tier ?? 'both';

    const siteRows = await loadSites(userTier);
    if (siteRows.length === 0) {
      console.warn('[scrape] No sites after filtering. Returning empty array.');
      return NextResponse.json([], { status: 200 });
    }

    const { data: rulesData, error: rulesErr } = await supabase
      .from('adapter_rules')
      .select('adapter_key,rules');
    if (rulesErr) throw rulesErr;

    const rulesMap = new Map<string, any>();
    (rulesData ?? []).forEach((r: AdapterRules) => rulesMap.set(r.adapter_key, r.rules));

    const apiRows: ApiRow[] = [];
    const dbRows: DbRow[] = []; // strictly DB-safe payload (no generated cols)
    const seen = new Set<string>();

    for (const site of siteRows) {
      const { data: runStart } = await supabase
        .from('scrape_runs')
        .insert({ site_id: site.id, status: 'started' })
        .select('id')
        .single();
      const runId = runStart?.id as number | undefined;
      const before = dbRows.length;

      try {
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

        console.log(`[scrape] ${site.name}: links found`, links.length);

        const parseDetail = buildParser(site.adapter_key, rulesMap.get(site.adapter_key));

        for (const url of links) {
          if (seen.has(url)) continue;
          seen.add(url);

          try {
            const detailHtml = await fetchHtml(url);
            const parsed = parseDetail(detailHtml, url, site.name);
            if (!parsed) continue;

            if (query && !parsed.prize.toLowerCase().includes(query.toLowerCase())) continue;

            const scraped_at = new Date().toISOString();
            const remaining_tickets = computeRemaining(parsed.total_tickets, parsed.tickets_sold);
            const odds = parsed.total_tickets ?? null;

            // API row (includes computed fields)
            const apiRow: ApiRow = {
              ...parsed,
              scraped_at,
              remaining_tickets,
              odds,
            };
            apiRows.push(apiRow);

            // DB row (excludes generated fields)
            const dbRow: DbRow = {
              prize: apiRow.prize,
              site_name: apiRow.site_name,
              entry_fee: apiRow.entry_fee,
              total_tickets: apiRow.total_tickets,
              tickets_sold: apiRow.tickets_sold,
              url: apiRow.url,
              scraped_at: apiRow.scraped_at,
            };
            dbRows.push(dbRow);

            await sleep(site.rate_limit_ms);
          } catch (e) {
            console.warn(`[scrape] detail error for ${url}:`, (e as any)?.message ?? e);
            continue;
          }
        }

        // Upsert ONLY the DB-safe rows we just added for this site
        const added = dbRows.length - before;
        console.log(`[scrape] ${site.name}: rows parsed`, added);

        if (added > 0) {
          const payload = dbRows.slice(before);
          const { error } = await supabase
            .from('competitions')
            .upsert(payload as any, { onConflict: 'url', ignoreDuplicates: false })
            .select();
          if (error) {
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
            console.error(`[scrape] upsert error for ${site.name}:`, error.message);
            continue;
          }
        }

        if (runId) {
          await supabase
            .from('scrape_runs')
            .update({
              status: 'ok',
              items_ingested: added,
              finished_at: new Date().toISOString(),
            })
            .eq('id', runId);
        }
      } catch (siteErr: any) {
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
        console.error(`[scrape] site-level error for ${site.name}:`, siteErr?.message ?? siteErr);
        continue;
      }
    }

    console.log('[scrape] total apiRows returned:', apiRows.length);
    return NextResponse.json(apiRows, { status: 200 });
  } catch (err: any) {
    console.error('Scrape route error:', err);
    return NextResponse.json({ error: err?.message ?? 'Unknown error' }, { status: 500 });
  }
}
