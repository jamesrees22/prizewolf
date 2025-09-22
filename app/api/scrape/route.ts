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
  adapter_key: string; // 'revcomps' | 'dcg' | 'generic' | etc.
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
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const toInt = (s?: string | null): number | null => {
  if (s == null) return null;
  const n = parseInt(String(s).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

const computeRemaining = (total?: number | null, sold?: number | null) => {
  if (total == null || sold == null) return null;
  const r = total - sold;
  return r >= 0 ? r : null;
};

// ---------- PRICE helpers ----------
const readJsonLdProduct = ($: CheerioAPI): { name?: string; price?: number | null } => {
  const blocks = $('script[type="application/ld+json"]')
    .map((_, el) => $(el).contents().text())
    .get();

  for (const raw of blocks) {
    try {
      const data = JSON.parse(raw);
      const nodes = Array.isArray(data) ? data : [data];
      for (const node of nodes) {
        const graph = Array.isArray(node?.['@graph']) ? node['@graph'] : [node];
        for (const g of graph) {
          const typeArr = g?.['@type'] ? (Array.isArray(g['@type']) ? g['@type'] : [g['@type']]) : [];
          if (typeArr.includes('Product')) {
            const offers = Array.isArray(g.offers) ? g.offers[0] : g.offers;
            const price = offers?.price ? Number(String(offers.price).replace(/[^\d.]/g, '')) : null;
            const name = typeof g.name === 'string' ? g.name.trim() : undefined;
            if (name || price != null) return { name, price: price ?? null };
          }
        }
      }
    } catch { /* ignore */ }
  }
  return {};
};

const readMetaPrice = ($: CheerioAPI): number | null => {
  const props = ['product:price:amount', 'og:price:amount', 'twitter:data1'];
  for (const p of props) {
    const v = $(`meta[property="${p}"], meta[name="${p}"]`).attr('content');
    const n = toFloat(v);
    if (n != null) return n;
  }
  return null;
};

// Gather candidate prices from DOM/text
const collectPriceCandidates = ($: CheerioAPI, rules?: any): number[] => {
  const cands: number[] = [];
  const pushN = (n: number | null) => {
    if (n != null && Number.isFinite(n)) cands.push(Number(n.toFixed(2)));
  };

  // Site-provided selectors first
  (rules?.price_selectors ?? []).forEach((sel: string) => pushN(toFloat($(sel).first().text())));

  // Common WooCommerce selectors
  [
    '.summary .price .amount',
    '.woocommerce-Price-amount',
    '.price .amount',
    '[class*="price"] .amount',
    '[class*="price"]'
  ].forEach((sel) => pushN(toFloat($(sel).first().text())));

  // data-* attributes that sometimes hold a price
  $('[data-price], [data-entry-price], [data-price-per-entry], [data-ticket-price]').each((_, el) => {
    pushN(toFloat($(el).attr('data-price')));
    pushN(toFloat($(el).attr('data-entry-price')));
    pushN(toFloat($(el).attr('data-price-per-entry')));
    pushN(toFloat($(el).attr('data-ticket-price')));
  });

  // STRICT text scan: require a £ sign
  const body = $('body').text();
  const strictMatches = body.match(/£\s?(\d+(?:\.\d{1,2})?)/g) || [];
  strictMatches.forEach((m) => pushN(toFloat(m)));

  // RELAXED scan (no £) only if nothing strict
  if (!strictMatches.length) {
    const relaxed = body.match(/\b(\d+(?:\.\d{1,2})?)\b/g) || [];
    relaxed.forEach((m) => pushN(toFloat(m)));
  }

  // Optional numeric range from rules
  const min: number | null = rules?.price_min ?? 0.01;
  const max: number | null = rules?.price_max ?? 100;
  return cands.filter((n) => (min == null || n >= min) && (max == null || n <= max));
};

// Choose most likely ticket price
const chooseBestPrice = (cands: number[], trusted?: number | null, rules?: any): number | null => {
  if (trusted != null) return trusted;
  if (!cands.length) return null;

  const preferMin = rules?.price_prefer_min ?? 0.15;
  const preferMax = rules?.price_prefer_max ?? 5.0;
  const preferUnder = rules?.price_prefer_under ?? 1.0;

  const inWin = (n: number) => n >= preferMin && n <= preferMax;
  const hasDecimals = (n: number) => Math.abs(n - Math.round(n)) > 1e-9;

  const decUnder = cands.filter((n) => hasDecimals(n) && n < preferUnder);
  if (decUnder.length) return Math.min(...decUnder);

  const decIn = cands.filter((n) => inWin(n) && hasDecimals(n));
  if (decIn.length) return Math.min(...decIn);

  const decAll = cands.filter(hasDecimals);
  if (decAll.length) return Math.min(...decAll);

  const intIn = cands.filter((n) => inWin(n) && !hasDecimals(n));
  if (intIn.length) return Math.min(...intIn);

  return Math.min(...cands);
};

/** DCG-specific price reader driven by rules: looks near "price_anchor_text" (e.g., "Online Entry") */
const extractPriceViaAnchor = ($: CheerioAPI, rules?: any): number | null => {
  const anchor: string | undefined = rules?.price_anchor_text;
  if (!anchor) return null;

  const html = $.root().html() ?? '';
  const re = new RegExp(`${anchor}[\\s\\S]{0,200}?£\\s?(\\d+(?:\\.\\d{1,2})?)`, 'i');
  const m = html.match(re);
  if (m?.[1]) return toFloat(m[1]);

  const text = $('body').text();
  const m2 = text.match(new RegExp(`${anchor}[\\s\\S]{0,200}?£\\s?(\\d+(?:\\.\\d{1,2})?)`, 'i'));
  if (m2?.[1]) return toFloat(m2[1]);

  return null;
};

// ---------- totals extractors ----------
type Totals = { total: number | null; sold: number | null; remaining?: number | null };

/** Try selectors from rules first (total_selector/sold_selector/remaining_selector) */
const extractTotalsFromSelectors = ($: CheerioAPI, rules?: any): Totals | null => {
  if (!rules) return null;

  const read = (sel?: string): number | null => {
    if (!sel) return null;
    const node = $(sel).first();
    if (!node.length) return null;
    return toInt(node.text());
  };

  const total = read(rules.total_selector);
  const sold = read(rules.sold_selector);
  const remaining = read(rules.remaining_selector);

  if (total != null || sold != null || remaining != null) {
    // derive missing piece if possible
    let t = total, s = sold, r = remaining;
    if (t == null && s != null && r != null) t = s + r;
    if (s == null && t != null && r != null) s = t - r;
    if (r == null && t != null && s != null) r = t - s;
    if (t != null && s != null && s > t) s = null;
    return { total: t ?? null, sold: s ?? null, remaining: r ?? undefined };
  }

  return null;
};

// Regex/text fallback
const extractTotalsGeneric = ($: CheerioAPI, rules?: any): Totals => {
  // 1) selector-first
  const selRes = extractTotalsFromSelectors($, rules);
  if (selRes) return selRes;

  // 2) text patterns
  const text = $('body').text();

  const totalPats: string[] = rules?.total_patterns ?? [
    'Number of Tickets\\s*([\\d,]+)',
    'Max Tickets\\s*([\\d,]+)',
    'Maximum Tickets\\s*([\\d,]+)',
    'Tickets Available\\s*([\\d,]+)\\s*/\\s*([\\d,]+)',
    '\\b([\\d,]+)\\s*entries\\b',
  ];
  const soldPats: string[] = rules?.sold_patterns ?? [
    '\\bSold\\s*:\\s*([\\d,]+)\\b',
    '\\b([\\d,]+)\\s*sold\\b',
  ];
  const remPats: string[] = rules?.remaining_patterns ?? [
    '\\b([\\d,]+)\\s*(?:tickets?|entries?)\\s*remaining\\b',
    '\\bremaining\\s*(?:tickets?|entries?)?:?\\s*([\\d,]+)\\b',
  ];

  let total: number | null = null;
  let sold: number | null = null;
  let remaining: number | null = null;

  for (const p of remPats) {
    const re = new RegExp(p, 'i');
    const m = text.match(re);
    if (m?.[1]) { remaining = toInt(m[1]); break; }
  }

  for (const p of totalPats) {
    const re = new RegExp(p, 'i');
    const m = text.match(re);
    if (m) { total = toInt(m[2] ?? m[1]); break; }
  }

  for (const p of soldPats) {
    const re = new RegExp(p, 'i');
    const m = text.match(re);
    if (m) { sold = toInt(m[1]); break; }
  }

  if (total == null && sold != null && remaining != null) total = sold + remaining;
  if (sold != null && total != null && sold > total) sold = null;

  return { total, sold, remaining: remaining ?? undefined };
};

// Scripts/attributes scan (for JS-rendered counts)
const scanScriptsAndAttrsForTotals = ($: CheerioAPI, rules?: any): Totals => {
  const scripts = $('script').map((_, el) => $(el).contents().text()).get().join('\n');
  const html = $.root().html() ?? '';

  const remPats: string[] = rules?.remaining_patterns_script ?? [
    '"remaining"\\s*:\\s*"*([\\d,]+)"*',
    '"tickets_remaining"\\s*:\\s*"*([\\d,]+)"*',
    'data-remaining\\s*=\\s*"([\\d,]+)"',
    'data-entries-remaining\\s*=\\s*"([\\d,]+)"',
  ];
  const soldPats: string[] = rules?.sold_patterns_script ?? [
    '"sold"\\s*:\\s*"*([\\d,]+)"*',
    'data-sold\\s*=\\s*"([\\d,]+)"',
  ];
  const maxPats: string[] = rules?.max_patterns_script ?? [
    '"max(?:imum)?_?(?:tickets|entries)"\\s*:\\s*"*([\\d,]+)"*',
    'data-max(?:-)?(?:tickets|entries)\\s*=\\s*"([\\d,]+)"',
  ];

  const firstMatch = (src: string, pats: string[]) => {
    for (const p of pats) {
      const re = new RegExp(p, 'i');
      const m = src.match(re);
      if (m?.[1]) return toInt(m[1]);
    }
    return null;
  };

  const remaining = firstMatch(scripts, remPats) ?? firstMatch(html, remPats);
  const sold = firstMatch(scripts, soldPats) ?? firstMatch(html, soldPats);
  const max = firstMatch(scripts, maxPats) ?? firstMatch(html, maxPats);

  let total = max;
  if (total == null && sold != null && remaining != null) total = sold + remaining;

  return { total, sold, remaining: remaining ?? undefined };
};

const extractTotalsRevComps = ($: CheerioAPI, rules?: any): Totals => {
  // selectors first
  const selRes = extractTotalsFromSelectors($, rules);
  if (selRes) return selRes;

  // script/html hints
  const scr = scanScriptsAndAttrsForTotals($, rules);
  if (scr.total != null || scr.sold != null || scr.remaining != null) return scr;

  // body text
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
  return { total, sold, remaining };
};

// DCG: selectors from rules → scripts/attrs → text
const extractTotalsDCG = ($: CheerioAPI, rules?: any): Totals => {
  const selRes = extractTotalsFromSelectors($, rules);
  if (selRes) return selRes;

  const scr = scanScriptsAndAttrsForTotals($, rules);
  if (scr.total != null || scr.sold != null || scr.remaining != null) return scr;

  return extractTotalsGeneric($, rules);
};

// ---------- parser factory ----------
const buildParser = (adapter_key: string, rules?: any) => {
  return (html: string, url: string, siteName: string): ApiRow | null => {
    const $ = load(html);

    const ld = readJsonLdProduct($);

    const prize =
      ld.name ||
      (rules?.prize_selectors ? $(rules.prize_selectors.join(',')).first().text().trim() : '') ||
      $('h1, h2.product_title, .woocommerce-loop-product__title').first().text().trim() ||
      $('[class*="prize"]').first().text().trim() ||
      $('meta[property="og:title"]').attr('content')?.trim() ||
      $('title').text().trim();

    if (!prize) return null;

    // PRICE (rules-driven)
    let entry_fee: number | null = null;
    entry_fee = extractPriceViaAnchor($, rules);
    if (entry_fee == null) {
      const metaPrice = readMetaPrice($);
      const candPrices = collectPriceCandidates($, rules);
      entry_fee = chooseBestPrice(candPrices, ld.price ?? metaPrice ?? null, rules);
      if (entry_fee == null) {
        console.warn('[scrape] price not found; url=', url, 'site=', siteName);
      }
    }

    // TOTALS (selectors → scripts → text)
    let totals: Totals;
    switch (adapter_key) {
      case 'revcomps':
        totals = extractTotalsRevComps($, rules);
        break;
      case 'dcg':
        totals = extractTotalsDCG($, rules);
        break;
      case 'generic':
      default:
        totals = extractTotalsGeneric($, rules);
        break;
    }

    const remaining_final = totals.remaining ?? computeRemaining(totals.total, totals.sold);

    return {
      prize,
      site_name: siteName,
      entry_fee,
      total_tickets: totals.total,
      tickets_sold: totals.sold,
      remaining_tickets: remaining_final ?? undefined,
      url,
    };
  };
};

// ---------- site loader with fallback + logging ----------
async function loadSites(userTier: 'free' | 'premium' | 'both') {
  const baseSel = 'id,name,list_url,link_selector,adapter_key,rate_limit_ms,tier,enabled';

  let { data, error } = await supabase
    .from('sites')
    .select(baseSel)
    .eq('enabled', true);
  if (error) throw error;

  let rows = (data ?? []) as SiteCfg[];
  if (!rows.length) {
    const retry = await supabase.from('sites').select(baseSel);
    if (retry.error) throw retry.error;
    rows = (retry.data ?? []) as SiteCfg[];
    console.warn('[scrape] No sites with enabled=true; falling back to all sites. Count:', rows.length);
  }

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
    const dbRows: DbRow[] = [];
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

        // Raw links
        let links = Array.from(
          new Set(
            $(site.link_selector)
              .map((_, a) => $(a).attr('href'))
              .get()
              .filter(Boolean)
              .map((href) => new URL(href!, site.list_url).href)
          )
        );

        // Allow/Deny via adapter rules
        const rules = rulesMap.get(site.adapter_key) ?? {};

        const defaultAllow =
          site.adapter_key === 'dcg' ? /\/competitions\//i :
          site.adapter_key === 'revcomps' ? /\/(product|competitions?)\//i :
          null;
        if (defaultAllow) links = links.filter((u) => defaultAllow.test(u));

        if (rules.link_allow_regex) {
          const allow = new RegExp(rules.link_allow_regex, 'i');
          links = links.filter((u) => allow.test(u));
        }
        if (rules.link_deny_regex) {
          const deny = new RegExp(rules.link_deny_regex, 'i');
          links = links.filter((u) => !deny.test(u));
        }

        if (site.adapter_key === 'dcg') {
          const denySlugs = new Set(['cash', 'cars', 'tech', 'instant', 'winners', 'draws', 'terms']);
          links = links.filter((u) => {
            const m = u.match(/\/competitions\/([^/?#]+)/i);
            if (!m) return false;
            const slug = m[1].toLowerCase();
            if (denySlugs.has(slug)) return false;
            return /[-\d]/.test(slug);
          });
        }

        links = links.slice(0, 60);
        console.log(`[scrape] ${site.name}: links found`, links.length);

        const parseDetail = buildParser(site.adapter_key, rules);

        for (const url of links) {
          if (seen.has(url)) continue;
          seen.add(url);

          try {
            const detailHtml = await fetchHtml(url);
            const parsed = parseDetail(detailHtml, url, site.name);
            if (!parsed) continue;

            if (query && !parsed.prize.toLowerCase().includes(query.toLowerCase())) continue;

            const scraped_at = new Date().toISOString();

            const apiRow: ApiRow = {
              ...parsed,
              scraped_at,
              odds: parsed.total_tickets ?? null,
            };
            if (apiRow.remaining_tickets == null) {
              apiRow.remaining_tickets = computeRemaining(apiRow.total_tickets, apiRow.tickets_sold) ?? undefined;
            }
            apiRows.push(apiRow);

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
          } else if (runId) {
            await supabase
              .from('scrape_runs')
              .update({
                status: 'ok',
                items_ingested: added,
                finished_at: new Date().toISOString(),
              })
              .eq('id', runId);
          }
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
