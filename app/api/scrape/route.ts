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
  url: string;
  scraped_at?: string;
};

type ApiRow = Row & { remaining_tickets: number | null };

// Config records from DB
type SiteCfg = {
  name: string;
  list_url: string;
  link_selector: string;
  adapter_key: string; // 'revcomps' | 'dcg' | 'generic' | future keys
  rate_limit_ms: number | null;
  tier: 'free' | 'premium' | 'both';
  enabled: boolean;
};

type AdapterRules = {
  adapter_key: string;
  rules: any; // JSON rules structure (see seed)
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
const computeRemaining = (total: number | null, sold: number | null): number | null => {
  if (total == null) return null;
  const rem = total - (sold ?? 0);
  return rem >= 0 ? rem : null;
};

// Ticket price: pick the smallest plausible amount (avoid cash-alts/prize values)
const extractTicketPrice = ($: CheerioAPI, rules?: any): number | null => {
  const text = $('body').text();
  const patterns: RegExp[] = (rules?.price_patterns ?? ['£\\s*([\\d.,]+)'])
    .map((p: string) => new RegExp(p, 'g'));

  const nums: number[] = [];
  for (const rx of patterns) {
    for (const m of text.matchAll(rx)) {
      const v = toFloat((m as any)[1]);
      if (v != null) nums.push(v);
    }
  }

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
    'max of\\s*([\\d,]+)\\s*tickets',
    '([\\d,]+)\\s*entries',
  ]).map((p: string) => new RegExp(p, 'i'));

  const soldPatterns: RegExp[] = (rules?.sold_patterns ?? [
    'Tickets?\\s*sold\\s*([\\d,]+)',
    'Sold:\\s*([\\d,]+)',
  ]).map((p: string) => new RegExp(p, 'i'));

  let total: number | null = null;
  for (const rx of totalPatterns) {
    const m = text.match(rx);
    if (m?.[1]) { total = toInt(m[1]); break; }
  }

  let sold: number | null = null;
  for (const rx of soldPatterns) {
    const m = text.match(rx);
    if (m?.[1]) { sold = toInt(m[1]); break; }
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
  let sold =
    toInt(text.match(/\b(?:tickets?|entries?)\s*sold\s*([\d,]+)\b/i)?.[1]) ??
    toInt(text.match(/\bsold:\s*([\d,]+)\b/i)?.[1]) ??
    null;

  let total =
    toInt(text.match(/\bmax(?:imum)?\s+(?:entries|tickets)\b[^\d]*([\d,]+)\b/i)?.[1]) ??
    toInt(text.match(/\btotal\s+(?:entries|tickets)\b[^\d]*([\d,]+)\b/i)?.[1]) ??
    null;

  if (total == null) {
    const m = text.match(/\b([\d,]+)\s*entries\b/i);
    if (m?.[1]) total = toInt(m[1]);
  }

  if (total == null && sold != null && remaining != null) total = sold + remaining;
  if (total != null && sold != null && sold > total) sold = null;

  return { total, sold };
};
// -----------------------------

// Build a site-specific parser based on adapter_key + rules
const buildParser = (adapterKey: string, rules?: any) => {
  return (html: string, url: string, siteName: string): Row | null => {
    const $ = load(html);
    const prize = $('h1, h2').first().text().trim();
    if (!prize) return null;

    const entry_fee = extractTicketPrice($, rules);

    let totals: { total: number | null; sold: number | null };
    switch (adapterKey) {
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
      .select('name,list_url,link_selector,adapter_key,rate_limit_ms,tier,enabled')
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

    const upsertRows: Row[] = [];
    const apiRows: ApiRow[] = [];
    const seen = new Set<string>();

    for (const site of siteRows) {
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

            const row: Row = { ...parsed, scraped_at };
            upsertRows.push(row);

            const apiRow: ApiRow = { ...row, remaining_tickets };
            apiRows.push(apiRow);

            const pause = site.rate_limit_ms ?? 250;
            await new Promise((r) => setTimeout(r, pause));
          } catch (e) {
            console.warn(`Detail parse failed for ${site.name}: ${url}`, e);
          }
        }
      } catch (e) {
        console.error(`List fetch failed for ${site.name}`, e);
      }
    }

    if (upsertRows.length) {
      const { error } = await supabase
        .from('competitions')
        .upsert(upsertRows, { onConflict: 'url', ignoreDuplicates: false })
        .select();
      if (error) {
        console.error('Supabase upsert error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }

    return NextResponse.json(apiRows, { status: 200 });
  } catch (err: any) {
    console.error('Scrape route error:', err);
    return NextResponse.json({ error: err?.message ?? 'Unknown error' }, { status: 500 });
  }
}
