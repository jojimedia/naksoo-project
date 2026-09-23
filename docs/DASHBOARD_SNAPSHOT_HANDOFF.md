# Dashboard snapshot / initial-load handoff

Last updated: 2026-09-23 (KST)

## Goal

Make the dashboard's first response cheap and predictable:

1. The collector computes the dashboard view when collection data changes.
2. PostgreSQL stores the finished JSON snapshot.
3. A web request reads one versioned row and does no roster join or ranking aggregation.
4. After hydration, `/live/events` and `/live/snapshot` overlay live totals and donors.

Live freshness must not depend on rebuilding the initial snapshot for every gift.

## 장애 회고: 왜 처음부터 이렇게 처리하지 못했나

결론부터 말하면 병목을 잘못 짚었다. 처음에는 초기 로딩 지연을 DB 조회와 집계 비용 문제로 판단했고, 메모리 캐시와 요약 스냅샷을 먼저 강화했다. 이 작업은 DB 부하를 줄이는 데는 필요했지만, 사용자가 기다리던 첫 화면의 주된 병목은 아니었다.

당시 요청 경로는 다음과 같았다.

```text
GET /
  -> force-dynamic Next.js 서버 렌더링
  -> 스냅샷/DB 조회
  -> 131명 전체 카드와 랭킹을 React 서버에서 렌더링
  -> 약 1.34MB의 HTML/RSC 직렬화
  -> 브라우저 전송 및 hydration
  -> SSE 연결
```

메모리 캐시는 `스냅샷을 읽는 시간`만 줄였다. 131명 전체를 요청마다 React로 렌더링하고 큰 RSC 응답으로 직렬화하는 비용은 그대로였기 때문에, 캐시 적중 여부와 무관하게 `/`의 TTFB가 약 2.6초에 머물렀다.

특히 다음 측정 결과가 나온 시점에 SSR 병목으로 즉시 전환했어야 했다.

| 측정 대상 | 당시 결과 | 의미 |
| --- | ---: | --- |
| 라이브 스냅샷 API | 약 0.07초, 약 11.8KB | 실시간 데이터 제공 경로는 이미 빠름 |
| 버전 API | 약 0.18~0.27초 | DB 접속이 첫 화면 2~5초 지연의 주원인은 아님 |
| 기존 `/` | 약 2.8초, 약 1.48MB | 서버 렌더링·직렬화·전송이 지배적인 병목 |
| 요약 스냅샷 적용 후 `/` | 약 2.6초, 1,339,527 bytes | DB 최적화만으로 초기 화면이 해결되지 않음을 확인 |

즉, `데이터를 빠르게 읽는 것`과 `페이지 응답을 빠르게 보내는 것`을 같은 문제로 본 판단이 잘못이었다. 먼저 각 구간의 TTFB와 응답 크기를 분리 측정하고, 위 증거가 나온 즉시 정적 셸과 데이터 API를 분리했어야 했다.

## 근본 원인

1. `/`가 `force-dynamic` 경로여서 모든 방문마다 전체 대시보드를 다시 서버 렌더링했다.
2. 131명 전체 카드, 크루 랭킹, 후원자 데이터를 HTML/RSC에 포함해 응답 크기가 과도하게 컸다.
3. 월 선택을 서버 `searchParams`에 결합해 루트 페이지의 정적 캐시를 사용할 수 없었다.
4. 메모리 캐시가 DB 쿼리는 줄였지만 React 렌더링, RSC 직렬화, 네트워크 전송 비용은 줄이지 못했다.
5. 최초 진단에서 DB/캐시 가설에 고정되어, 이미 확보된 API와 루트 페이지의 속도 차이를 충분히 빠르게 반영하지 못했다.

## 최종 해결 방법

해결은 두 단계로 나눴다.

### 1. 수집 시점에 화면용 데이터를 미리 계산

- 수집기가 멤버, 크루, 일일 별풍선, 어제 별풍선, 후원자 목록을 화면용 payload로 미리 만든다.
- 준비된 payload는 `ranking_cache`의 `dashboard:current` 또는 `dashboard:period:YYYY-MM` 키에 저장한다.
- 프론트 API는 관계형 테이블을 다시 조립하지 않고 한 행의 `payload_json`만 읽는다.
- 서버 프로세스에는 5초 메모리 캐시를 둬 동일 스냅샷의 반복 역직렬화와 DB 조회를 줄였다.
- 월별 전체 일일 배열 두 개는 초기 화면 payload에서 제거하고 `yesterday_balloons` 스칼라만 유지했다.

### 2. 첫 HTML과 대시보드 데이터를 분리

```text
GET /
  -> 정적으로 캐시된 2.9KB 로딩 셸을 즉시 응답
  -> 브라우저가 GET /api/dashboard 호출
  -> 준비된 스냅샷 한 행 반환
  -> 클라이언트가 대시보드 렌더링
  -> SSE가 라이브 별풍선·후원자 값을 계속 덮어씀
```

- `frontend/app/page.tsx`는 DB와 무관한 작은 정적 셸만 렌더링한다.
- `frontend/app/dashboard-loader.tsx`가 브라우저에서 `/api/dashboard`를 호출한다.
- `frontend/app/api/dashboard/route.ts`가 준비된 스냅샷을 반환하며 짧은 공유 캐시를 사용한다.
- 라이브 정확도는 기존 SSE를 유지해 정적 셸 도입으로 실시간성이 희생되지 않게 했다.
- 월 선택은 클라이언트가 API 파라미터로 전달하므로 루트 페이지는 계속 정적으로 유지된다.

## 운영 검증 결과

2026-09-23 운영 배포 후 같은 서비스에서 측정한 값이다.

| 항목 | 변경 전/중간 | 최종 | 결과 |
| --- | ---: | ---: | --- |
| 루트 HTML 크기 | 1,339,527 bytes | 2,926 bytes | 약 99.8% 감소 |
| 루트 warm TTFB | 약 2.6초 | 약 0.036초 | 약 72배 개선 |
| 루트 첫 요청 TTFB | 약 5초까지 발생 | 약 0.223초 | 정적 캐시로 콜드 영향 축소 |
| `/api/dashboard` 첫 요청 | 해당 없음 | 약 0.92초 | 스냅샷 API 콜드 시작 포함 |
| `/api/dashboard` warm | 해당 없음 | 약 0.04~0.09초 | 준비된 payload와 메모리/공유 캐시 사용 |

운영 응답 헤더에서도 루트 페이지의 `x-nextjs-cache: HIT`와 장기 `s-maxage`가 확인됐다. 브라우저에서 전체 카드, 월 선택, LIVE 표시, 후원자 데이터를 확인했고 콘솔 오류는 없었다. SSE 엔드포인트는 `text/event-stream`으로 초기 스냅샷을 전송했으며, 수집기 health 응답에서 라이브 및 연결 스트림이 정상 확인됐다.

## 재발 방지 기준

- 프로덕션 빌드 결과에서 `/`는 반드시 정적 경로 `○ /`로 표시되어야 한다. `ƒ /`로 바뀌면 성능 회귀로 본다.
- `/api/dashboard`만 동적 경로 `ƒ /api/dashboard`여야 한다.
- warm 상태 기준 루트 TTFB 목표는 150ms 이하, 전송 크기는 20KB 이하로 유지한다.
- warm 상태 기준 `/api/dashboard` TTFB 목표는 200ms 이하로 유지한다.
- 성능 문제가 생기면 DB부터 추정하지 말고 DNS/TLS, TTFB, 응답 bytes, 데이터 API, React 렌더링을 각각 측정한다.
- 메모리 캐시는 데이터 조회 캐시이지 렌더링 결과 캐시가 아니다. 두 효과를 동일하게 취급하지 않는다.
- 전체 멤버 일일 배열처럼 첫 화면에 불필요한 데이터는 스냅샷에 다시 넣지 않는다.
- 라이브 값은 SSE를 최종 우선순위로 유지하며, 정적 셸이나 공유 캐시가 라이브 덮어쓰기를 막아서는 안 된다.

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
  -> serve a prebuilt static loading shell (no database and no React list SSR)
  -> browser GET /api/dashboard
  -> getCachedDashboardSnapshot("dashboard:current")
  -> SELECT payload_json, generated_at FROM ranking_cache WHERE cache_key = $1
  -> render the already prepared CrewDashboard payload in the browser
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
  - Is now a static loading shell, so opening `/` performs no database query
    and does not server-render every member card.
- `frontend/app/dashboard-loader.tsx`
  - Loads the one prepared dashboard snapshot after the static shell paints.
  - Preserves month switching through the URL query string.
- `frontend/app/api/dashboard/route.ts`
  - Serves current or recent-month prepared snapshots.
  - Adds short CDN caching and stale-while-revalidate.
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
  The build output confirms `/` is static and only `/api/dashboard` is dynamic.
- Backend full suite in an isolated virtualenv: 30 tests passed.
- `python3 -m py_compile backend/dashboard_cache.py backend/realtime_db.py backend/realtime_worker.py`: passed.
- `git diff --check`: passed.
- Isolated compact-snapshot assertion: passed; yesterday was retained and both
  daily arrays were absent.

The host Python did not contain the backend dependencies, so the full suite was
run in a temporary virtualenv populated from `backend/requirements.txt`.
Existing repository-wide ESLint failures are in pre-existing React
effect/purity rules and are not caused by this snapshot change.

## Deployment order

1. Deploy the collector/backend first.
2. Wait for one successful `Cycle saved` so compact `dashboard:*` rows exist.
3. Deploy the frontend.
4. Open the dashboard once, then verify SSE values change without a page reload.

The frontend remains compatible with the older snapshot shape, so the rolling
deployment is safe; backend-first simply realizes the payload reduction sooner.

## Production measurement commands

Record before/after values for:

```bash
curl -L --compressed -o /dev/null -sS \
  -w 'ttfb=%{time_starttransfer} total=%{time_total} bytes=%{size_download}\n' \
  https://<production-host>/
```

Acceptance criteria:

- No members/crews query in the page request path.
- One `ranking_cache` row read at most once per five seconds per frontend
  process.
- Initial `/` response remains below 20 KB and does not server-render the
  complete dashboard.
- `/api/dashboard` returns the prepared JSON with no ranking computation.
- Live score/donor updates continue through SSE without waiting for snapshot
  regeneration.

## Do not change these invariants

- Poonggo live/SSE session totals remain authoritative for live and final daily
  totals.
- Database writes stay batched; do not write once per rendered page or once per
  gift from the frontend.
- The public page must never call upstream Poong/Poonggo APIs.
- Do not restore full donor lists or two months of daily arrays to the initial
  RSC payload.
- The shared Poong.today chart may update only the monthly fallback total. Its
  08:00 reporting-day value must never be written into a KST daily slot.
- `save_result` preloads recent broadcast-session day overrides with one query;
  do not move that lookup inside the member/month upsert loop.
