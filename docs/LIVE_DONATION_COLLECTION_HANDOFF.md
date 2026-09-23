# 낙수표 실시간 별풍선 수집 로직 인수인계

최종 코드 갱신: 2026-09-23

> 2026-09-23 후속 수정: `streamer_live_totals`의 현재 행을 `streamer_live_sessions`에서 다시 찾아 `previous_*`로 붙이던 SQL 때문에, 방종한 방송이 `오늘/어제` 양쪽에 같은 값으로 보일 수 있었다. 이전 방송 조회에서 현재 `broadcast_no`와 현재 `reporting_date`를 제외하고, 인메모리 병합에서도 `previous_date == date`이면 중복 필드를 제거한다. 또한 수집기의 `fans`, `previous_fans`를 준비된 대시보드 스냅샷까지 전달해 재시작·새로고침 뒤에도 오늘/어제 후원자가 유지되게 했다.

> 2026-09-19 변경: 아래의 기존 `broadcast_session_v3` 설명은 과거 설계 기록이다. 현재 구현은 풍고 **방송별 라이브 URL**(`/station/{user_id}/{SOOP broadcast_no}`)의 `liveInfo.donationAmount`를 기준으로 하는 `broadcast_live_v4`다. 풍고 `/daily`의 금액을 합산하거나 새 방송 금액에서 이전 방송분을 차감하지 않는다. SSE 후원을 즉시 더하고 방송별 라이브 누적값으로 보정하며, 방종 후 마지막 값을 확정해 유지한다. DB의 `reporting_date`는 방송 시작일, `display_date`는 그 값을 화면에 보여줄 날짜다. 이 메모를 아래 과거 설명보다 우선해서 적용한다.

## 1. 목표

낙수표의 별풍선 데이터는 아래 우선순위를 지켜야 한다.

1. 첫 화면은 PostgreSQL에 저장된 캐시로 빠르게 응답한다.
2. 라이브 방송 중인 스트리머는 Poonggo SSE 후원 이벤트를 메모리에 즉시 반영한다.
3. 브라우저에는 변경된 스트리머만 SSE로 전달한다.
4. DB에는 이벤트마다 쓰지 않고 짧은 주기 또는 일정 개수 단위로 묶어서 저장한다.
5. 라이브 중 방송별 HTML 집계와 SSE 사이에 차이가 생기면 90초 주기의 스냅샷으로 보정한다.
6. 방종 후에는 마지막 라이브 수치를 확정한다. 전체 날짜별 보정은 이 값을 덮지 않는다.
7. 일일 집계의 기준은 달력 자정이 아니라 **실제 SOOP 방송 세션의 시작일**이다.

## 2. 핵심 문제와 원인

### 오늘/어제 값이 같은 후속 장애

운영 SSE에서 함지아 행이 아래처럼 저장된 사례가 확인됐다.

```text
date=2026-09-22, today=20,556
previous_date=2026-09-22, previous_balloons=20,556
broadcast_no=297299479
```

원인은 `load_live_totals()`가 어제 방송을 찾을 때 현재 행과 같은 방송 세션을 제외하지 않은 것이다. 현재 방송 자체가 `previous_*`로 한 번 더 결합됐고, 프론트는 두 필드를 서로 다른 날짜 데이터로 신뢰했다.

수정 규칙은 다음과 같다.

- 이전 세션 조회에서 현재 `broadcast_no`를 제외한다.
- 이전 세션 조회에서 현재 `reporting_date`와 같은 날짜를 제외한다.
- 인메모리 상태 병합 후에도 `previous_date == date`이면 `previous_*`를 삭제한다.
- 같은 날짜의 두 번째 방송은 별도 방송으로 유지하되, 같은 날짜 값을 어제 값으로 복제하지 않는다.

### 숫자는 있는데 후원자가 비는 후속 장애

준비된 `dashboard:*` 스냅샷은 초기 로딩을 줄이면서 `yesterday_balloons` 숫자만 보존하고 `daily_fans`, `yesterday_fans`를 넣지 않았다. 그 결과 SSE 메모리에 남아 있는 최근 라이브 방송은 후원자가 보였지만, 새로고침·재시작·오프라인 상태에서는 숫자만 남고 후원자 목록이 비었다.

수정 후 흐름은 다음과 같다.

```text
Poonggo 라이브/최종 스냅샷
  -> fans + previous_fans
  -> realtime_totals
  -> dashboard:current
  -> daily_fans + yesterday_fans
  -> 프론트 오늘/어제 후원자 목록
```

이 수정은 이미 수집된 방송 세션의 후원자를 보존하고 전달하는 수정이다. 실시간 수집 도입 전에 끝난 과거 방송처럼 DB에 방송 세션 자체가 없는 경우에는 후원자를 새로 만들어낼 수 없으며, 필요하면 별도의 저속 과거 보정 작업이 필요하다.

### 혜밍 오집계 사례

- 2026-09-16 풍고 일일 값: `77,930`
- 2026-09-17 풍고 일일 값: `19,115`
- 잘못 표시된 값: `97,045`
- `77,930 + 19,115 = 97,045`

초기 구현은 풍고 날짜 페이지의 `streamNo`가 양쪽 날짜에서 같으면 같은 방송이라고 판단해 두 날짜를 합산했다. 하지만 풍고 페이지의 `streamNo`는 해당 날짜의 방송 세션 ID가 아니다. 현재 또는 마지막 방송 정보가 여러 날짜 페이지에서 반복될 수 있다.

따라서 풍고 `streamNo`만 비교하면 서로 다른 방송도 같은 방송으로 오판한다.

### 반대 방향의 문제

단순히 자정마다 무조건 분리하면 실제로 자정을 넘겨 계속된 동일 방송도 두 방송처럼 나뉜다. 또한 라이브 중 올바르게 합산한 값이 방송 종료 후 2시간 전체 보정에서 다시 달력 날짜 값으로 덮어써질 수 있었다.

결론적으로 다음 두 기준을 분리해야 한다.

- 풍고 방송별 페이지: 해당 방송의 `liveInfo.donationAmount`를 읽는 자료
- 실제 방송 세션 판정: SOOP의 `broadcast_no`와 풍고 라이브 페이지의 `startedAt` 사용
- 풍고 날짜별 페이지: 오늘의 별풍선 수집 경로에서 사용하지 않음

## 3. 현재 데이터 흐름

```text
SOOP 라이브 상태 API
  └─ broadcast_no + broadcast_start + is_live
                │
                ▼
Poonggo 방송별 라이브/월간 HTML ── 방송 누적 기준값 및 90초 정확도 보정
                │
Poonggo SSE ──────────── 라이브 후원 즉시 누적
                │
                ▼
PoonggoLiveService 인메모리 상태
  ├─ 변경 스트리머만 프론트 SSE 전송
  └─ 2초 또는 이벤트 20개 단위 PostgreSQL 저장
                │
                ▼
Next.js 프론트 ── 최초 캐시 렌더링 후 SSE 값으로 해당 멤버만 갱신
```

수치는 환경변수로 조정할 수 있다.

- `NAKSOO_POONGGO_RECONCILE_SECONDS`: 라이브 HTML 보정 주기, 기본 90초
- `NAKSOO_LIVE_FLUSH_SECONDS`: DB 배치 저장 주기, 기본 2초
- `NAKSOO_LIVE_FLUSH_EVENT_COUNT`: 즉시 저장을 유발하는 누적 이벤트 개수, 기본 20개

## 4. 방송 세션 판정 규칙

### 같은 방송

다음 값이 유지되면 같은 방송이다.

- SOOP `broadcast_no`가 동일
- SOOP `broadcast_start`가 동일한 방송 시작 시각을 가리킴

같은 방송이 자정을 넘으면 풍고 라이브 페이지의 `startedAt` 날짜를 `reporting_date`로 유지한다. 날짜별 페이지를 합산하지 않고, 해당 방송의 라이브 누적값을 그대로 사용한다. `display_date`는 현재 KST 날짜로 갱신되어 자정 뒤에도 프론트에서 같은 방송 값을 표시한다.

예시:

```text
방송 시작: 2026-09-16 23:10
SOOP BNO: 12345
풍고 방송별 라이브 누적: 40,000

세션 기준 결과:
reporting_date = 2026-09-16
today = 40,000
```

### 다른 방송

같은 날짜라도 SOOP `broadcast_no`가 바뀌면 새 방송이다. 새 방송의 풍고 라이브 페이지가 이미 그 방송만의 누적값을 제공하므로 이전 방송분을 차감하지 않는다.

```text
첫 방송 종료 누적: 19,000
두 번째 방송의 라이브 누적: 3,000

두 번째 방송 세션 값 = 3,000
```

`session_offset`은 구버전 호환 필드로 남아 있지만 `broadcast_live_v4` 계산에는 사용하지 않는다.

### 라이브 여부를 알 수 없는 전체 검수

실시간 서비스의 전체 멤버 풍고 날짜별 검수는 중단했다. 라이브가 끝나면 마지막 방송별 스냅샷을 시도하고, 페이지가 이미 내려가 읽을 수 없으면 마지막 SSE 값을 유지한다.

## 5. 집계 모드

`streamer_live_totals.counting_mode`에는 집계의 신뢰 수준과 방식이 저장된다.

- `legacy`: 이전 버전에서 저장된 값. 재보정 대상이다.
- `calendar_day_v2`: SOOP 방송 세션 정보 없이 풍고의 한 날짜만 사용한 값이다.
- `broadcast_session_v3`: 실제 SOOP `broadcast_no`와 `broadcast_start`를 기준으로 계산한 세션 값이다.
- `broadcast_live_v4`: 풍고 방송별 라이브 누적값과 SSE를 사용하며 방종 후 확정하는 현재 방식이다.

새 코드에서 라이브 스트리머의 목표 상태는 `broadcast_live_v4`이다.

## 6. 스냅샷과 SSE 충돌 방지

풍고 HTML은 SSE보다 늦게 갱신될 수 있다. 예를 들어 SSE로 100개가 즉시 올라간 직후 HTML에는 이전 값이 남아 있을 수 있다.

이를 막기 위해 다음 규칙을 사용한다.

1. HTML 요청 시작 전 `_event_revision`을 기억한다.
2. HTML 요청 중 SSE 후원이 도착해 revision이 바뀌면 SSE로 증가한 값을 낮추지 않는다.
3. 같은 실제 방송에서는 HTML 값과 현재 값 중 큰 값을 유지한다.
4. 후원 이벤트 ID는 메모리와 DB에서 중복 제거한다.

단, 새 SOOP `broadcast_no`가 감지되면 이전 방송의 값은 새 방송 값으로 그대로 승계하지 않는다.

## 7. 주요 파일

### `backend/poonggo_live.py`

실시간 집계의 중심이다.

- `fetch_poonggo_snapshot()`
  - SOOP 방송번호로 풍고 방송별 라이브 페이지를 요청하고 `liveInfo.donationAmount`를 읽는다.
  - 월간 페이지도 함께 요청한다.
  - 날짜별 페이지의 `streamNo` 또는 `donationAmount`는 사용하지 않는다.
- `parse_broadcast_start_date()`
  - SOOP의 방송 시작 시각을 KST 날짜로 변환한다.
- `apply_snapshot()`
  - 같은 방송의 HTML 지연값이 SSE 값을 낮추지 못하게 한다.
  - 다른 SOOP 방송번호이면 새 방송의 값으로 교체한다.
- `apply_donation()`
  - SSE 후원을 메모리에 즉시 더하고 후원자별 누적도 갱신한다.
  - 이벤트 ID 중복을 제거한다.
- `_consume_sse()`
  - 스트리머 방송별 Poonggo SSE에 연결하고 끊기면 재연결한다.
- `_reconcile()`
  - 라이브 스트리머를 기본 90초마다 방송별 HTML 스냅샷으로 보정한다.
- `_finalize_stream()`
  - 방종 시 마지막 방송별 값을 확인하고 최종 상태를 고정한다.
- `flush_forever()`
  - 메모리 변경분과 후원 이벤트를 DB에 묶어서 저장한다.

### `backend/realtime_db.py`

실시간 상태와 후원 이벤트를 PostgreSQL에 저장한다.

주요 테이블:

- `live_donation_events`
  - 후원 이벤트 ID, 스트리머, 실제 방송번호, 수량, 발생시각, 원문 payload
  - `donation_id`가 PK이므로 재연결 후 중복 이벤트가 저장되지 않는다.
- `streamer_live_totals`
  - 스트리머별 현재 핫 상태
  - `broadcast_no`, `reporting_date`, `display_date`, `today_balloons`, `month_balloons`
  - `daily_fans`, `counting_mode`, `finalized`, 연결 상태 및 관측 시각

`persist_live_updates()`는 메모리 배치를 저장한 뒤 월간 캐시의 해당 일자 값도 갱신한다.

### `backend/realtime_worker.py`

- SOOP 라이브 상태를 주기적으로 확인한다.
- 실제 `broadcast_no`와 station API의 `broadcast_start`를 캐시 항목에 넣는다.
- 19금 방송은 player API만 믿지 않고 공개 라이브 목록을 함께 확인한다.
- 라이브 종료 시 마지막 상세 수집과 복구 대상을 예약한다.

### `backend/dashboard_cache.py`

PostgreSQL에 저장된 결과를 초기 프론트 응답에 적합한 가벼운 구조로 변환한다. 프론트 첫 화면은 이 캐시를 사용하므로 전체 원본 재수집을 기다리지 않는다.

### `frontend/app/api/live/events/route.ts`

브라우저가 백엔드 수집기에 직접 연결하지 않도록 Next.js가 내부 수집기의 SSE를 프록시한다.

### `frontend/app/crew-dashboard.tsx`

- 최초 서버 렌더링 데이터 위에 실시간 스트리머 값을 덮어쓴다.
- 전체 멤버를 30초마다 다시 요청하지 않는다.
- SSE에서 변경된 `user_id`의 값만 React 상태에 반영한다.

## 8. 절대 지켜야 할 불변조건

향후 수정 시 아래 조건을 깨면 이전 오류가 재발한다.

1. **풍고 HTML의 `streamNo`로 방송 동일성을 판단하지 않는다.**
2. 방송 동일성은 SOOP의 실제 `broadcast_no`를 기준으로 판단한다.
3. 세션의 귀속 날짜는 풍고 라이브 `startedAt`의 KST 날짜이며 SOOP `broadcast_start`는 SSE 초기값의 보조 기준이다.
4. 같은 BNO가 자정을 넘으면 방송별 누적값을 유지한다. 날짜 조각을 합산하지 않는다.
5. BNO가 바뀌면 같은 날이어도 새 방송으로 분리한다.
6. HTML 보정값이 그보다 최신인 SSE 값을 감소시키면 안 된다.
7. 방송별 라이브 값과 확정된 최종값을 풍고 날짜별 값으로 덮으면 안 된다.
8. 후원 이벤트는 `donation_id`로 멱등 처리한다.
9. 브라우저는 멤버 전체를 반복 재호출하지 않고 변경 멤버만 반영한다.
10. DB 저장 지연 때문에 브라우저 실시간 반영까지 늦어지면 안 된다. 메모리와 프론트 전송이 먼저다.
11. 풍투 공용 차트의 `day` 값은 오전 8시 경계를 사용하므로 `daily_balloons`에 저장하지 않는다. 공용 차트는 월 누계 보조값으로만 쓴다.
12. `daily_balloons`의 최근 날짜를 확정할 수 있는 주체는 `streamer_live_sessions`의 실제 SOOP 방송번호 세션뿐이다.

### 2026-09-24 이온 중복 장애의 구조적 원인

이온(`qor0919`)의 실제 방송 `297321935`는 2026-09-23 00:29 KST에 시작했고 풍고 방송별 최종값은 111,116개였다. 그러나 기존 공용 풍투 차트 조회는 오전 8시 전에는 조회 날짜를 `현재 KST - 8시간`으로 계산했다.

그 결과 같은 값을 다음 순서로 두 번 썼다.

1. 9월 23일 오전 8시 전: 조회 날짜 9월 22일, 111,116을 22일 슬롯에 저장
2. 오전 8시 이후: 조회 날짜 9월 23일, 같은 111,116을 23일 슬롯에도 저장

운영 스냅샷에서 이온 외에도 안둥, 윤아현, 유림, 도예빈이 같은 형태로 탐지됐다. 이는 숫자가 우연히 같은 문제가 아니라 `풍투 보고일`과 `방송 시작일 세션`을 한 `daily_balloons` 배열에 함께 저장한 소유권 충돌이었다.

수정 후 데이터 소유권은 다음과 같다.

- 풍투 공용 차트: `total_balloons` 월 누계 보조, `chart_totals` 진단 정보
- 풍고 방송별 페이지/SSE: 방송 세션의 `today_balloons`, 후원자, 방종 최종값
- `streamer_live_sessions`: 실제 `broadcast_no`별 영속 원장
- `daily_balloons`: 상세 수집 결과 위에 같은 날짜의 최신 방송 세션 값을 덮어쓴 화면용 호환 배열

`save_result()`는 저장 사이클마다 세션을 멤버별로 반복 조회하지 않는다. 최근 120일의 날짜별 최신 세션을 한 번 읽어 메모리 맵으로 만든 후 모든 멤버에 적용한다. 따라서 정확성 보정이 DB N+1 병목을 만들지 않는다.

월 경계에서는 세션 행의 월 누계용 `year/month`가 아니라 `reporting_date`의 연월을 일별 슬롯 귀속에 사용한다. 예를 들어 9월 30일에 시작해 10월 1일에 끝난 방송은 9월 30일 슬롯 하나에만 남는다.

SSE 메모리값은 2초 단위 DB 배치보다 먼저 화면에 공개된다. 저장 시에는 DB 세션 보정 후 아직 flush되지 않은 `realtime_totals`의 `poonggo_sse`/`poonggo_live_final` 값을 마지막으로 덮어쓴다. 이 순서를 바꾸면 새 후원이 도착한 직후 이전 DB 세션으로 잠깐 역행할 수 있다.

## 9. 테스트

핵심 테스트 파일은 `backend/test_poonggo_live.py`다.

현재 포함된 주요 회귀 테스트:

- 풍고 사이드바가 아닌 요청 스트리머의 요약값만 파싱
- 방송별 라이브·월간 페이지 동시 요청
- 요청한 SOOP 방송번호와 다른 풍고 라이브 응답 거부
- 동일 방송이 자정을 넘어도 시작일과 누적값 유지
- 같은 날짜의 새 BNO는 자체 라이브 누적값 사용
- SSE 이벤트 즉시 반영과 이벤트 ID 중복 제거
- 늦은 HTML 스냅샷이 최신 SSE 값을 낮추지 않음
- 방종 후 마지막 SSE 값 고정 및 오래된 방송의 종료 작업이 새 방송을 덮지 못함
- 같은 날짜의 현재 방송을 `previous_*`로 중복 저장하지 않음
- 준비된 대시보드 스냅샷이 오늘·어제 후원자를 유지함

실행 방법:

```bash
PYTHONPATH=backend:/tmp/naksoo-live-test-deps python3 -m unittest backend.test_poonggo_live -v
```

2026-09-24 기준 격리된 환경에서 백엔드 전체 37개 테스트가 통과했다.

## 10. 배포 구조

Cloudtype 프로젝트에는 프론트와 수집기가 분리되어 있다.

- 프론트 서비스 서브 디렉터리: `frontend`
- 수집기 서비스 이름: `naksoo-collector`
- 수집기 서브 디렉터리: `backend`
- 배포 브랜치: GitHub `main`

백엔드 변경 배포 절차:

1. GitHub `main`에 커밋을 push한다.
2. Cloudtype의 `naksoo-collector` 서비스 설정에서 `배포하기`를 실행한다.
3. 최신 커밋이 `적용됨`인지 확인한다.
4. 서비스 상태가 롤링 중 `시작 중 (2/1)`에서 최종 `실행 중 (1/1)`이 되는지 확인한다.
5. 프론트에서 라이브 멤버 값이 SSE로 증가하는지 확인한다.

`5911583`은 과거 v3 배포 기록이다. v4 변경은 별도 배포 여부를 확인해야 한다.

## 11. 알려진 한계와 후속 검토 지점

1. 풍고 방송별 HTML은 최근 후원 일부만 내보낼 수 있다. 전체 방송 후원자 순위가 필요하면 방송별 페이지네이션 또는 이벤트 기반 누적을 별도 검증해야 한다. 현재 v4의 별풍선 총량과 후원자 목록의 완전성은 별개다.
2. 방송 종료 후 풍고 `liveInfo`가 사라지면 최종 HTML 재조회가 실패할 수 있다. 이 경우 마지막 SSE 누적값을 고정한다.
3. 월 경계를 넘는 방송은 세션 귀속일과 월간 합계의 소속 월이 달라질 수 있다. 월말 장기 방송 검증 테스트를 추가하는 것이 좋다.
4. 이전 `legacy` 값은 첫 정확 스냅샷 전까지 잠깐 노출될 가능성이 있다. 필요하면 legacy 상태를 우선 보정하는 시작 단계 마이그레이션을 추가한다.
5. Cloudtype 롤링 배포 중 구 버전과 신 버전이 잠깐 함께 실행될 수 있다. DB 스키마 변경은 `ADD COLUMN IF NOT EXISTS`처럼 이전 버전과 호환되게 유지한다.

## 12. 다른 AI가 작업을 시작할 때 확인할 순서

1. 이 문서의 불변조건을 먼저 확인한다.
2. `backend/poonggo_live.py`의 `fetch_poonggo_snapshot`, `apply_snapshot`, `apply_donation`을 읽는다.
3. `backend/realtime_db.py`에서 `streamer_live_totals` 스키마와 upsert 필드를 확인한다.
4. `backend/test_poonggo_live.py` 회귀 테스트를 먼저 실행한다.
5. 실제 장애 값이 있으면 다음 항목을 한 묶음으로 비교한다.
   - SOOP `broadcast_no`
   - SOOP `broadcast_start`
   - 상태의 `reporting_date`
   - `counting_mode`
   - `display_date`와 `finalized`
   - `source`
   - `observed_at`
6. 풍고 날짜 페이지의 `streamNo`가 같다는 이유만으로 날짜를 합치지 않는다.
7. 수정 뒤에는 자정 통과 동일 방송, 같은 날 새 방송, 방종 최종값, SSE 중 HTML 보정 테스트를 반드시 유지한다.
