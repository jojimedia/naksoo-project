# Dashboard snapshot / initial-load handoff

Last updated: 2026-09-23 (KST)

## Goal

Make the dashboard's first response cheap and predictable:

1. The collector computes the dashboard view when collection data changes.
2. PostgreSQL stores the finished JSON snapshot.
3. A web request reads one versioned row and does no roster join or ranking aggregation.
4. After hydration, `/live/events` and `/live/snapshot` overlay live totals and donors.

Live freshness must not depend on rebuilding the initial snapshot for every gift.

## Implemented architecture

`ranking_cache` is the existing durable summary table. The rows used as the
dashboard snapshots are:

- `dashboard:current`
- `dashboard:period:YYYY-MM`

`backend/realtime_db.py::save_result` writes the compatible raw cache and the
collector-prepared dashboard snapshot in the same transaction. The snapshot is
built by `backend/dashboard_cache.py::build_dashboard`.

The frontend hot path is now:

```text
GET /
  -> getCachedDashboardSnapshot("dashboard:current")
  -> SELECT payload_json, generated_at FROM ranking_cache WHERE cache_key = $1
  -> render the already prepared CrewDashboard payload
  -> connect SSE and overlay live values in the browser
```

The PostgreSQL read has a five-second process-memory cache. It is deliberately
short: SSE handles live scores, while roster/snapshot changes become visible
quickly. An admin mutation clears this process cache immediately.

## Changes made in this pass

- `frontend/lib/ranking-cache.ts`
  - Added `getCachedDashboardSnapshot`.
  - Reads payload and version with one query instead of version query + payload
    query.
  - Added a five-second prepared-snapshot memory cache.
- `frontend/app/page.tsx`
  - Removed the per-request `listMembers` / `listRegisteredCrewNames` overlay.
  - Removed per-request raw-to-dashboard aggregation on the production hot
    path.
  - Retains a raw-cache fallback for a rolling deployment with an older
    collector.
- `backend/dashboard_cache.py`
  - Replaced two complete daily arrays per streamer with the scalar
    `yesterday_balloons` in the prepared snapshot.
  - `display_day_balloons` remains today's initial value.
- `frontend/app/crew-dashboard.tsx`
  - Uses the snapshot's `yesterday_balloons` first.
  - Still accepts old snapshots containing daily arrays during rolling deploys.
- `frontend/app/crew-card.tsx` and `frontend/lib/membership-view.ts`
  - Daily arrays are optional for backward compatibility.
- `frontend/app/api/admin/members/route.ts`
  - Clears the new prepared-snapshot memory cache after admin mutations.
- `backend/test_live_totals.py`
  - Added a regression test for the compact yesterday scalar.

## Why membership remains correct

The collector reads the PostgreSQL `members` table on its normal loop and
`backend/member_sync.py::align_members` makes that roster authoritative before
`save_result` creates `dashboard:*`. Existing members retain statistics by SOOP
ID; new members receive a placeholder until their targeted collection finishes.

The old frontend roster overlay was a second source of work and was executed on
every page request. It has been removed from the production read path. During a
membership change, the current UI should use its admin response immediately;
the public snapshot follows on the collector's next membership cycle. Do not
reintroduce a per-request members-table join. If faster cross-instance roster
visibility is needed, rebuild the one affected `dashboard:*` row at mutation
time or add a collector command for that member.

## Verification completed

- `frontend/node_modules/.bin/tsc --noEmit`: passed.
- `frontend/npm run build`: passed (production build, all routes compiled).
- `python3 -m py_compile backend/dashboard_cache.py backend/realtime_db.py backend/realtime_worker.py`: passed.
- `git diff --check`: passed.
- Isolated compact-snapshot assertion: passed; yesterday was retained and both
  daily arrays were absent.

Full local Python discovery could not run because the host Python does not have
`httpx` and `psycopg`. Existing repository-wide ESLint failures are in
pre-existing React effect/purity rules and are not caused by this snapshot
change.

## Deployment order

1. Deploy the collector/backend first.
2. Wait for one successful `Cycle saved` so compact `dashboard:*` rows exist.
3. Deploy the frontend.
4. Open the dashboard once, then verify SSE values change without a page reload.

The frontend remains compatible with the older snapshot shape, so the rolling
deployment is safe; backend-first simply realizes the payload reduction sooner.

## Production checks still required

Record before/after values for:

```bash
curl -L --compressed -o /dev/null -sS \
  -w 'ttfb=%{time_starttransfer} total=%{time_total} bytes=%{size_download}\n' \
  https://<production-host>/
```

Expected outcomes:

- No members/crews query in the page request path.
- One `ranking_cache` row read at most once per five seconds per frontend
  process.
- Initial response materially smaller than the previous uncompressed ~1.48 MB.
- Live score/donor updates continue through SSE without waiting for snapshot
  regeneration.

If the response is still too large after deployment, the next optimization is
UI rendering, not Redis: render only the visible crew card initially and mount
the other cards on demand. The snapshot DB read is already constant-time.

## Do not change these invariants

- Poonggo live/SSE session totals remain authoritative for live and final daily
  totals.
- Database writes stay batched; do not write once per rendered page or once per
  gift from the frontend.
- The public page must never call upstream Poong/Poonggo APIs.
- Do not restore full donor lists or two months of daily arrays to the initial
  RSC payload.
