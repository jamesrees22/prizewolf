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

// What we return to the client (enriched, not stored)
type ApiRow = Row & {
  remaining_tickets: number | null;
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

// Smallest plausible ticket price (avoid cash-alternative/prize values)
const extractTicketPrice = ($: CheerioAPI): number | null => {
  const text = $('body').text();
  const poundMatches = Array.from(text.matchAll(/£\s*([\d.,]+)/g))
    .map((m) => toFloat(m[1]))
    .filter((n): n is number => n != null);
  const plausible = poundMatches.filter((v) => v >= 0.1 && v <= 50);
  if (plausible.length === 0) return null;
  return Math.min(...plausible);
};

const extractTotalsGeneric = ($: CheerioAPI) => {
  const text = $('body').text();
  let total =
    toInt(text.match(/Number of Tickets\s*([\d,]+)/i)?.[1]) ??
    toInt(text.match(/max of\s*([\d,]+)\s*tickets/i)?.[1]) ??
    toInt(text.match(/([\d,]+)\s*entries/i)?.[1]) ??
    null;

  let sold =
    toInt(text.match(/Tickets?\s*sold\s*([\d,]+)/i)?.[1]) ??
    toInt(text.match(/Sold:\s*([\d,]+)/i)?.[1]) ??
    null;

  if (total != null && sold != null && sold > total) sold = null;
  return { total, sold };
};

const extractTotalsRevComps = ($: CheerioAPI) => {
  const text = $('body').text();

  const maxPhrase = toInt(text.match(/\bPRIZE HAS A MAX OF\s*([\d,]+)\s*TICKETS\b/i)?.[1]);
  let sold = toInt(text.match(/\bSOLD:\s*([\d,]+)/i)?.[1]) ?? null;
  const remaining = toInt(text.match(/\bREMAINING:\s*([\d,]+)/i)?.[1]) ?? null;

  let total = maxPhrase ?? null;
  if (total == null && sold != null && remaining != null) total = sold + remaining;
  if (total != null && sold != null && sold > total) sold = null;

  if (total == null) {
    const g = extractTotalsGeneric($);
    total = g.total;
    if (sold == null) sold = g.sold;
  }
  return { total, sold };
};
// -----------------------------

const sites = [
  {
    name: 'Rev Comps',
    listUrl: 'https://www.revcomps.com/current-competitions/',
    linkSelector: 'a[href*="/product/"]',
    parseDetail: (html: string, url: string): Row | null => {
      const $ = load(html);
      const prize = $('h1, h2').first().text().trim();
      if (!prize) return null;

      const entry_fee = extractTicketPrice($);
      const { total, sold } = extractTotalsRevComps($);

      return {
        prize,
        site_name: 'Rev Comps',
        entry_fee,
        total_tickets: total,
        tickets_sold: sold,
        url,
      };
    },
  },
  {
    name: 'Dream Car Giveaways',
    listUrl: 'https://dreamcargiveaways.co.uk/competitions',
    linkSelector: 'a[href*="/competitions/"]',
    parseDetail: (html: string, url: string): Row | null => {
      const $ = load(html);
      const prize = $('h1, h2').first().text().trim();
      if (!prize) return null;

      const entry_fee = extractTicketPrice($);
      const { total, sold } = extractTotalsGeneric($);

      return {
        prize,
        site_name: 'Dream Car Giveaways',
        entry_fee,
        total_tickets: total,
        tickets_sold: sold,
        url,
      };
    },
  },
];

export async function POST(req: NextRequest) {
  try {
    const { query } = await req.json().catch(() => ({ query: '' as string }));
    const upsertRows: Row[] = [];
    const apiRows: ApiRow[] = [];
    const seen = new Set<string>();

    for (const site of sites) {
      try {
        const listHtml = await fetchHtml(site.listUrl);
        const $ = load(listHtml);

        const links = Array.from(
          new Set(
            $(site.linkSelector)
              .map((_, a) => $(a).attr('href'))
              .get()
              .filter(Boolean)
              .map((href) => new URL(href!, site.listUrl).href)
          )
        ).slice(0, 60);

        for (const url of links) {
          if (seen.has(url)) continue;
          seen.add(url);

          try {
            const detailHtml = await fetchHtml(url);
            const parsed = site.parseDetail(detailHtml, url);
            if (!parsed) continue;

            if (query && !parsed.prize.toLowerCase().includes(String(query).toLowerCase())) {
              continue;
            }

            const scraped_at = new Date().toISOString();
            const remaining_tickets = computeRemaining(parsed.total_tickets, parsed.tickets_sold);

            const row: Row = { ...parsed, scraped_at };
            upsertRows.push(row);

            const apiRow: ApiRow = { ...row, remaining_tickets };
            apiRows.push(apiRow);

            await new Promise((r) => setTimeout(r, 250));
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
