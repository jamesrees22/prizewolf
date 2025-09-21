import { NextRequest, NextResponse } from 'next/server';
import { load } from 'cheerio';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const sites = [
  { name: 'Rev Comps', url: 'https://revcomps.com/competitions', selector: '.comp-item' },
  { name: '7 Days Performance', url: 'https://7daysperformance.com/competitions', selector: '.prize-card' },
  { name: 'Elite Competitions', url: 'https://elitecompetitions.co.uk/collections/all', selector: '.product-card' },
  { name: 'BOTB', url: 'https://botb.com/competitions', selector: '.comp-entry' },
  { name: 'Dream Car Giveaways', url: 'https://dreamcargiveaways.co.uk/competitions', selector: '.comp-card' },
];

export async function POST(req: NextRequest) {
  const { query } = await req.json();
  const comps: any[] = [];

  for (const site of sites) {
    try {
      const res = await fetch(site.url, { headers: { 'User-Agent': 'PrizeWolf/1.0' } });
      const html = await res.text();
      const $ = load(html);

      $(site.selector).each((i, el) => {
        const prize = $(el).find('.prize-title, .product-title, .comp-title').text().trim();
        if (query && !prize.toLowerCase().includes(query.toLowerCase())) return;

        const entryFee = parseFloat($(el).find('.entry-price, .price').text().replace(/[^0-9.]/g, '')) || 0;
        const totalTickets = parseInt($(el).find('.total-tickets, .ticket-count').text().replace(/[^0-9]/g, '')) || 1000000;
        const soldTickets = parseInt($(el).find('.sold, .tickets-sold').text().replace(/[^0-9]/g, '')) || 0;
        const url = $(el).find('a').attr('href') || site.url;

        comps.push({
          prize,
          site_name: site.name,
          entry_fee: entryFee,
          total_tickets: totalTickets,
          tickets_sold: soldTickets,
          url: new URL(url, site.url).href,
        });
      });

      // Rate limit: 2s delay
      await new Promise((r) => setTimeout(r, 2000));
    } catch (error) {
      console.error(`Scrape failed for ${site.name}:`, error);
    }
  }

  if (comps.length > 0) {
    const { error } = await supabase.from('competitions').upsert(comps, { onConflict: ['prize', 'site_name'] });
    if (error) {
      console.error(error);
      return NextResponse.json({ error: 'Failed to save data' }, { status: 500 });
    }
  }

  return NextResponse.json(comps);
}