# 낙수표 실시간 별풍선 수집 로직 인수인계

작성 기준: 2026-09-17  
배포 기준 커밋: `5911583` (`Track daily totals by real broadcast session`)

## 1. 목표

낙수표의 별풍선 데이터는 아래 우선순위를 지켜야 한다.

1. 첫 화면은 PostgreSQL에 저장된 캐시로 빠르게 응답한다.
2. 라이브 방송 중인 스트리머는 Poonggo SSE 후원 이벤트를 메모리에 즉시 반영한다.
3. 브라우저에는 변경된 스트리머만 SSE로 전달한다.
4. DB에는 이벤트마다 쓰지 않고 짧은 주기 또는 일정 개수 단위로 묶어서 저장한다.
5. 라이브 중 HTML 집계와 SSE 사이에 차이가 생기면 90초 주기의 스냅샷으로 보정한다.
6. 전체 멤버는 약 2시간마다 저속으로 검수하되 라이브 세션 값을 훼손하면 안 된다.
7. 일일 집계의 기준은 달력 자정이 아니라 **실제 SOOP 방송 세션의 시작일**이다.

## 2. 핵심 문제와 원인

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

- 풍고 날짜 페이지: 날짜별 별풍선 금액과 후원자 목록을 읽는 자료
- 실제 방송 세션 판정: SOOP의 `broadcast_no`와 `broadcast_start`만 사용

## 3. 현재 데이터 흐름

```text
SOOP 라이브 상태 API
  └─ broadcast_no + broadcast_start + is_live
                │
                ▼
Poonggo 일일/월간 HTML ── 초기 기준값 및 90초 정확도 보정
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
- `NAKSOO_POONGGO_ROSTER_RECONCILE_SECONDS`: 전체 멤버 검수 주기, 기본 7200초
- `NAKSOO_POONGGO_ROSTER_RECONCILE_DELAY`: 전체 검수 멤버 간 지연, 기본 0.5초
- `NAKSOO_LIVE_FLUSH_SECONDS`: DB 배치 저장 주기, 기본 2초
- `NAKSOO_LIVE_FLUSH_EVENT_COUNT`: 즉시 저장을 유발하는 누적 이벤트 개수, 기본 20개

## 4. 방송 세션 판정 규칙

### 같은 방송

다음 값이 유지되면 같은 방송이다.

- SOOP `broadcast_no`가 동일
- SOOP `broadcast_start`가 동일한 방송 시작 시각을 가리킴

같은 방송이 자정을 넘으면 `broadcast_start`의 날짜를 `reporting_date`로 유지한다. 풍고가 자정 기준으로 나눈 각 날짜 페이지를 가져와 하나의 방송 세션 값으로 합산한다.

예시:

```text
방송 시작: 2026-09-16 23:10
SOOP BNO: 12345
16일 풍고: 30,000
17일 풍고: 10,000

세션 기준 결과:
reporting_date = 2026-09-16
today = 40,000
```

### 다른 방송

같은 날짜라도 SOOP `broadcast_no`가 바뀌면 새 방송이다. 풍고 일일 페이지는 그날 여러 방송의 합계를 제공하므로 새 방송의 값은 이전 방송 누적분을 빼서 계산한다.

```text
첫 방송 종료 누적: 19,000
두 번째 방송 중 풍고 일일 누적: 22,000

두 번째 방송 세션 값 = 22,000 - 19,000 = 3,000
session_offset = 19,000
```

이 차감 기준은 `session_offset`으로 PostgreSQL에 저장하여 프로세스 재시작 뒤에도 유지한다.

### 라이브 여부를 알 수 없는 전체 검수

SOOP 세션 정보 없이 수행하는 전체 검수는 풍고의 현재 날짜 값만 사용하며 `calendar_day_v2`로 표시한다. 이미 `broadcast_session_v3`로 확정된 상태는 전체 달력 보정이 덮어쓰지 않는다. 풍고 달력 페이지만으로는 종료된 자정 통과 방송을 정확히 재구성할 수 없기 때문이다.

## 5. 집계 모드

`streamer_live_totals.counting_mode`에는 집계의 신뢰 수준과 방식이 저장된다.

- `legacy`: 이전 버전에서 저장된 값. 재보정 대상이다.
- `calendar_day_v2`: SOOP 방송 세션 정보 없이 풍고의 한 날짜만 사용한 값이다.
- `broadcast_session_v3`: 실제 SOOP `broadcast_no`와 `broadcast_start`를 기준으로 계산한 세션 값이다.

새 코드에서 라이브 스트리머의 목표 상태는 `broadcast_session_v3`이다.

## 6. 스냅샷과 SSE 충돌 방지

풍고 HTML은 SSE보다 늦게 갱신될 수 있다. 예를 들어 SSE로 100개가 즉시 올라간 직후 HTML에는 이전 값이 남아 있을 수 있다.

이를 막기 위해 다음 규칙을 사용한다.

1. HTML 요청 시작 전 `_event_revision`을 기억한다.
2. HTML 요청 중 SSE 후원이 도착해 revision이 바뀌면 SSE로 증가한 값을 낮추지 않는다.
3. 같은 방송·같은 집계 모드에서 현재 상태의 source가 `poonggo_sse`이면 HTML 값과 현재 값 중 큰 값을 유지한다.
4. 후원 이벤트 ID는 메모리와 DB에서 중복 제거한다.

단, 새 SOOP `broadcast_no`가 감지되면 이전 방송의 값은 새 방송 값으로 그대로 승계하지 않는다.

## 7. 주요 파일

### `backend/poonggo_live.py`

실시간 집계의 중심이다.

- `fetch_poonggo_snapshot()`
  - 라이브 세션이면 `broadcast_start`부터 현재 날짜까지 필요한 풍고 일일 페이지를 동시에 요청한다.
  - 월간 페이지도 함께 요청한다.
  - 풍고 페이지의 `streamNo`는 세션 판정에 사용하지 않는다.
- `parse_broadcast_start_date()`
  - SOOP의 방송 시작 시각을 KST 날짜로 변환한다.
- `apply_snapshot()`
  - 같은 방송의 HTML 지연값이 SSE 값을 낮추지 못하게 한다.
  - 같은 날 새 방송이면 `session_offset`을 계산한다.
- `apply_donation()`
  - SSE 후원을 메모리에 즉시 더하고 후원자별 누적도 갱신한다.
  - 이벤트 ID 중복을 제거한다.
- `_consume_sse()`
  - 스트리머 방송별 Poonggo SSE에 연결하고 끊기면 재연결한다.
- `_reconcile()`
  - 라이브 스트리머를 기본 90초마다 HTML 스냅샷으로 보정한다.
- `reconcile_roster_forever()`
  - 전체 멤버를 기본 2시간마다 저속 검수한다.
  - 완료된 `broadcast_session_v3` 값은 달력 집계로 덮지 않는다.
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
  - `broadcast_no`, `reporting_date`, `today_balloons`, `month_balloons`
  - `daily_fans`, `counting_mode`, `session_offset`, 연결 상태 및 관측 시각

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
3. 세션의 귀속 날짜는 SOOP `broadcast_start`의 KST 날짜다.
4. 같은 BNO가 자정을 넘으면 세션 값을 유지하고 날짜 조각을 합산한다.
5. BNO가 바뀌면 같은 날이어도 새 방송으로 분리한다.
6. HTML 보정값이 그보다 최신인 SSE 값을 감소시키면 안 된다.
7. 전체 2시간 보정이 `broadcast_session_v3`를 `calendar_day_v2`로 덮으면 안 된다.
8. 후원 이벤트는 `donation_id`로 멱등 처리한다.
9. 브라우저는 멤버 전체를 반복 재호출하지 않고 변경 멤버만 반영한다.
10. DB 저장 지연 때문에 브라우저 실시간 반영까지 늦어지면 안 된다. 메모리와 프론트 전송이 먼저다.

## 9. 테스트

핵심 테스트 파일은 `backend/test_poonggo_live.py`다.

현재 포함된 주요 회귀 테스트:

- 풍고 사이드바가 아닌 요청 스트리머의 요약값만 파싱
- 일일·월간 페이지 동시 요청
- 풍고 `streamNo`가 날짜마다 반복되어도 무조건 합산하지 않음
- 실제 SOOP 방송 시작일이 전날이면 자정 양쪽 날짜를 합산
- 동일 방송이 자정을 넘어도 시작일과 누적값 유지
- 같은 날짜의 새 BNO는 이전 세션 누적분 차감
- SSE 이벤트 즉시 반영과 이벤트 ID 중복 제거
- 늦은 HTML 스냅샷이 최신 SSE 값을 낮추지 않음

실행 방법:

```bash
PYTHONPATH=/tmp/naksoo-test-deps python3 -m unittest discover -s backend -p 'test_*.py'
```

2026-09-17 기준 전체 백엔드 테스트 19개가 통과했다.

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

배포 커밋 `5911583` 적용 후 혜밍 값이 잘못 합산된 `97,045`가 아닌 당시 라이브 진행값 `26,905`로 표시되는 것을 확인했다.

## 11. 알려진 한계와 후속 검토 지점

1. 풍고 일일 후원자 목록은 달력 누적 목록이다. 같은 날 여러 방송을 세션별로 나눌 때 전체 별풍선 수는 `session_offset`으로 분리하지만 후원자별 과거 세션 차감은 완전하지 않을 수 있다. 정확한 세션별 후원자 순위가 필요하면 방송별 donor offset 또는 이벤트 기반 세션 테이블을 추가해야 한다.
2. 현재 3일을 초과하는 초장기 연속 방송은 외부 부하 제한을 위해 세션 날짜 합산에서 제외된다. 실제 요구가 생기면 요청 상한과 캐시 전략을 함께 조정해야 한다.
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
   - `session_offset`
   - `source`
   - `observed_at`
6. 풍고 날짜 페이지의 `streamNo`가 같다는 이유만으로 날짜를 합치지 않는다.
7. 수정 뒤에는 자정 통과 동일 방송, 같은 날 새 방송, SSE 중 HTML 보정의 세 회귀 테스트를 반드시 유지한다.
