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

---

## 🚧 Now (in progress / near term)
- [ ] UI: Show **Remaining tickets** column in results table
- [ ] Improve odds formatting (e.g. `1 in 3463` → `1 in 3,463`)
- [ ] Add more site adapters (e.g. 7Days Performance, Elite Competitions)
- [ ] Clean up error handling/logging in scraper route

---

## ⏭ Next (planned)
- [ ] User accounts: gate sites by **free vs premium tier**
- [ ] Add dark mode toggle / theme switcher in UI
- [ ] Build `/api/debug-sites` for quick Supabase connectivity tests
- [ ] Public roadmap page: show features + allow votes (powered by Supabase table)

---

## 🌀 Later (nice-to-haves / stretch goals)
- [ ] Mobile app wrapper (React Native / Expo)
- [ ] Browser extension for quick odds lookup
- [ ] Notification system (email or push) when new comps match saved searches
- [ ] Affiliate/commission tracking for outbound clicks

---

### Notes
- Keep schema migrations in `/supabase/sql`.
- Tie GitHub commits/PRs to backlog items (e.g. `closes #12`).
- Periodically groom this list: promote "Now" → "Done" or "Next".
