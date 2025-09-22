# PrizeWolf Feature Backlog

This document tracks ideas, features, and improvements for PrizeWolf.  
Use it as a living backlog. Update frequently!

---

## ✅ Done
- Dynamic site/adapters loaded from Supabase (`sites`, `adapter_rules`)
- Added RevComps-specific totals parsing (SOLD/REMAINING)
- Added Dream Car Giveaways (generic rules-driven)
- Remaining tickets returned in API response
- Odds now generated as "1 in N remaining"
- Search also fires on **Enter key** (not just Search button)
- Add **loading indicator** (spinner/progress bar) while searching/scraping
- Improve odds formatting (e.g. `1 in 3463` → `1 in 3,463`)
- Add **favicon** (basic wolf icon until branded assets are ready)
- Results page: add **sort & filter** (odds ↑/↓, entry fee ↑/↓)

---

## 🚧 Now (in progress / near term)
- [ ] UI: Show **Remaining tickets** column in results table
- [ ] UI polish: enlarge logo, reduce spacing above search box
- [ ] Clean up error handling/logging in scraper route
- [ ] Add more site adapters (e.g. 7Days Performance, Elite Competitions)

---

## ⏭ Next (planned)
- [ ] **Scheduled full-site crawl** (daily job via Vercel Cron / Supabase Schedule)
  - Stop scrape-on-search, always query DB
  - Free users = daily refresh, Premium = multiple times/day
- [ ] User accounts: gate sites/features by **free vs premium tier**
- [ ] Dashboard page as post-login landing:
  - New today, Lowest odds, Slow sellers, Ending soon
- [ ] Add site header/nav with **Login/Logout**, Dashboard, Search, Profile
- [ ] Add dark mode toggle / theme switcher in UI
- [ ] Build `/api/debug-sites` for quick Supabase connectivity tests
- [ ] Public roadmap page: show features + allow votes (powered by Supabase table)

---

## 🌀 Later (nice-to-haves / stretch goals)
- [ ] "Mark as entered" → save which comps a user has joined
- [ ] Email digests:
  - Free: weekly
  - Premium: daily/customised (latest, lowest odds, by keyword)
- [ ] Mobile app wrapper (React Native / Expo)
- [ ] Browser extension for quick odds lookup
- [ ] Notification system (email or push) when new comps match saved searches
- [ ] Affiliate/commission tracking for outbound clicks
- [ ] Custom wolf running loader animation (Lottie or CSS sprite) for search


---

### Notes
- Keep schema migrations in `/supabase/sql`.
- Tie GitHub commits/PRs to backlog items (e.g. `closes #12`).
- Periodically groom this list: promote "Now" → "Done" or "Next".
