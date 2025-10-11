// app/api/cron/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { POST as runScrape } from '../scrape/route';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const CRON_SECRET = process.env.CRON_SECRET;

  // Verify Vercel Cron
  const auth = req.headers.get('authorization');
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Invoke scraper
  const body = JSON.stringify({ tier: 'both', query: '' });
  const internal = new NextRequest(new Request(req.nextUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-cron-key': CRON_SECRET,
    },
    body,
  }));

  try {
    const scrapeRes = await runScrape(internal);

    // >>> NEW: self-heal statuses after scrape
    const url = process.env.SUPABASE_URL!;
    const key = process.env.SUPABASE_SERVICE_KEY!; // use same key as scraper
    const supabase = createClient(url, key);

    // close by time
    const nowIso = new Date().toISOString();
    const { error: e1 } = await supabase
      .from('competitions')
      .update({ is_closed: true })
      .lt('ends_at', nowIso)
      .eq('is_closed', false);
    if (e1) console.error('cron close-by-time error:', e1.message);

    // close by sell-out (needs SQL helper below)
    const { error: e2 } = await supabase.rpc('close_by_sellout');
    if (e2) console.error('cron close-by-sellout error:', e2.message);

    return scrapeRes;
  } catch (err: any) {
    console.error('Cron → scrape failed:', err);
    return NextResponse.json({ error: err?.message ?? 'Unknown error' }, { status: 500 });
  }
}
