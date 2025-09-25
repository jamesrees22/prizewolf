// app/api/cron/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { POST as runScrape } from '../scrape/route'; // call the existing scrape handler

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const CRON_SECRET = process.env.CRON_SECRET;

  // Verify the Vercel Cron invocation via Authorization: Bearer <CRON_SECRET>
  const auth = req.headers.get('authorization');
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Build a synthetic NextRequest to invoke the scrape POST internally
  const body = JSON.stringify({ tier: 'both', query: '' });
  const internal = new NextRequest(new Request(req.nextUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // your scrape route expects this header (x-cron-key) for auth
      'x-cron-key': CRON_SECRET,
    },
    body,
  }));

  try {
    const res = await runScrape(internal);
    // Pass through the result (counts etc.) so logs show what happened
    return res;
  } catch (err: any) {
    console.error('Cron → scrape failed:', err);
    return NextResponse.json({ error: err?.message ?? 'Unknown error' }, { status: 500 });
  }
}
