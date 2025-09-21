// app/api/scrape/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { load } from 'cheerio';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

// Service-role client (server-only). Make sure these envs are set in Codespaces/Vercel.
const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_KEY as string
);

// Matches the columns used by your UI (results/search pages)
type Row = {
  prize: string;
  site_name: string;
  entry_fee: number | null;
  total_tickets: number | null;
  tickets_sold: number | null;
  url: string;
  scraped_at?: string; // default now()
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

// Helpers
const toNumber = (s?: string | null): number | null => {
  if (!s) return null;
  const n = parseFloat(s.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const toInt = (s?: string | null): number | null => {
  if (!s) return null;
  const n = parseInt(s.replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};
const computeOdds = (total: number | null, sold: number | null): number | null => {
  if (total == null) return null;
  const remaining = sold == null ? total : Math.max(total - sold, 0);
  return remaining > 0 ? remaining : null; // "1 in remaining"
};

// Site adapters
const sites: Array<{
  name: string;
  listUrl: string;
  linkSelector: string;
  parseDetail: (html: string, url: string) => Row | null;
}> = [
  {
    name: 'Rev Comps',
    listUrl: 'https://www.revcomps.com/current-competitions/',
    linkSelector: 'a[href*="/product/"]',
    parseDetail: (html: string, url: string): Row | null => {
      const $ = load(html);
      const prize = $('h1, h2').first().text().trim();
      if (!prize) return null;

      // Heuristics from visible page text
      const text = $.text();
      const price = toNumber(text.match(/£\s*([\d.,]+)/)?.[1]);
      const sold = toInt(text.match(/SOLD:\s*([\d,]+)/i)?.[1]);
      const total =
        toInt(text.match(/Number of Tickets\s*([\d,]+)/i)?.[1]) ??
        toInt(text.match(/max of\s*([\d,]+)\s*tickets/i)?.[1]) ??
        null;

      return {
        prize,
        site_name: 'Rev Comps',
        entry_fee: price,
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

      const text = $.text();
      const price = toNumber(text.match(/£\s*([\d.,]+)/)?.[1]);
      const total = toInt(text.match(/([\d,]+)\s*entries/i)?.[1]);
      const sold = toInt(text.match(/Tickets sold\s*([\d,]+)/i)?.[1]);

      return {
        prize,
        site_name: 'Dream Car Giveaways',
        entry_fee: price,
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
    const rows: Row[] = [];
    const seen = new Set<string>();

    for (const site of sites) {
      try {
        const listHtml = await fetchHtml(site.listUrl);
        const $ = load(listHtml);

        // Collect unique absolute links
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

            // Client-side filter by query if present
            if (query && !parsed.prize.toLowerCase().includes(String(query).toLowerCase())) {
              continue;
            }

            rows.push({
              ...parsed,
              scraped_at: new Date().toISOString(),
            });

            // Be polite to hosts
            await new Promise((r) => setTimeout(r, 250));
          } catch (e) {
            console.warn(`Detail parse failed for ${site.name}: ${url}`, e);
          }
        }
      } catch (e) {
        console.error(`List fetch failed for ${site.name}`, e);
      }
    }

    if (rows.length) {
      // Upsert by URL (requires a UNIQUE(url) constraint for best effect)
      const { error } = await supabase
        .from('competitions')
        .upsert(rows, { onConflict: 'url', ignoreDuplicates: false })
        .select();
      if (error) {
        console.error('Supabase upsert error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }

    return NextResponse.json(rows, { status: 200 });
  } catch (err: any) {
    console.error('Scrape route error:', err);
    return NextResponse.json({ error: err?.message ?? 'Unknown error' }, { status: 500 });
  }
}
