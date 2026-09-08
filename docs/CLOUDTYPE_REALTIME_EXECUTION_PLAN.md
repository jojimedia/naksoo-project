# Cloudtype 실시간 낙수표 실행 계획

## 1. 목적과 범위

이 문서는 기존 `GitHub Actions → result.json → Next.js` 구조에서
Cloudtype 기반의 준실시간 구조로 **완료 전환한 뒤의 실행 기준 문서**다.

초기 목표는 다음으로 한정한다.

- 방송 중인 등록 스트리머의 월간 별풍선 데이터를 1~10분 간격으로 갱신한다.
- 최신 낙수표를 PostgreSQL에 저장하고 Next.js API로 제공한다.
- 원천 API의 갱신 지연과 우리 수집 지연을 구분해 기록한다.
- 데이터 이력은 3개월만 보관한다.

이번 전환에서 하지 않는 일:

- Google Sheets 기반 회원/방명록/가입신청 CRUD의 즉시 이전
- Redis, CDN, 다중 Worker, 별도 FastAPI 공개 API 도입
- GitHub에 매분 JSON을 커밋하는 방식

## 2. 확정 아키텍처

```text
SOOP 라이브 상태 API ─┐
                      ▼
                Python Collector (상시 Worker)
풍투 API ──────────────┘
                      │ 변경 감지 · 복구 · 보관 정리
                      ▼
                 Cloudtype PostgreSQL
                  ├─ 현재 월 상태
                  ├─ 3개월 변경 이력
                  └─ ranking JSON 캐시 1건
                      ▲
                      │ 조회
Cloudtype Next.js ─────┘
  ├─ 기존 화면 및 관리자 API
  └─ /api/result (캐시 JSON 반환)
```

### 설계 결정

1. **FastAPI는 초기 도입하지 않는다.**
   현재 Next.js Route Handler가 이미 사용자·관리자 API를 제공한다. Python은
   수집 전용 Worker로만 실행한다. 외부 소비자가 늘어나거나 Python API가
   필요한 시점에만 FastAPI를 추가한다.
2. **PostgreSQL이 영구 원본(Source of Truth)이다.**
   Python 프로세스 메모리는 비교·스케줄링 캐시일 뿐이다.
3. **최종 ranking JSON은 DB에 한 건으로 저장한다.**
   Next.js가 매 요청마다 대규모 집계·정렬을 실행하지 않도록 한다.
4. **Google Sheets CRUD는 당분간 유지한다.**
   실시간 별풍선 수집 전환과 관리자 CRUD 전환을 한 번에 하지 않는다.

## 3. Cloudtype 권장 리소스

실시간 구조에는 프리티어를 사용하지 않는다. 프리티어는 서비스 중지와 임시
저장소 정책 때문에 상시 Worker와 운영 DB에 맞지 않는다.

| 서비스 | 초기 메모리 | 비고 |
|---|---:|---|
| Next.js | 0.5GB | 기존 화면·Route Handler |
| Python Collector | 0.5GB | 장기 실행 수집 프로세스 |
| PostgreSQL | 0.5GB | 최신 상태·이력·캐시 |
| 영구 디스크 | 10GB | PostgreSQL 전용 |

- 시작 구독: **Hobby, 메모리 1.5GB, 디스크 10GB**
- CPU: 기본 공유 CPU로 시작한다.
- 트래픽 초과 자동 결제: 초기에는 `중지`로 둔다.
- 각 서비스를 반드시 **구독 리소스**로 배포한다. 프리티어 리소스로
  배포하면 유료 구독 후에도 자동 중지 정책이 적용될 수 있다.

## 4. 데이터 소스 원칙

### 4.1 풍투

- 월간 총 별풍선: `bj/detail/get`의 `b`
- 일별 별풍선 및 팬 랭킹: `d[]`, `f[]`
- 월간 랭킹 보조/폴백: `chart/get?ctype=month`
- 일별 확인: `chart/get?ctype=day`

`bj/detail/get`과 `chart/get`은 원천 자체의 집계 반영이 지연될 수 있다.
따라서 1분마다 요청하더라도 화면이 완전한 실시간 값이 된다고 가정하지
않는다.

### 4.2 등록 스트리머 목록

현재는 Google Sheets가 등록 스트리머와 운영 메타데이터의 원본이다.
향후 복구할 Google 기반 요약 API가 있다면, 아래 인터페이스를 구현해 교체한다.

```python
class MemberSource:
    async def list_members(self) -> list[Member]: ...
```

Google API URL·인증 방법·응답 예시가 확정되기 전에는 기존 Google Sheets
호출을 유지한다.

### 4.3 라이브 상태

기존 `backend/main.py`의 SOOP 라이브 상태 조회 로직을 재사용한다. 라이브
감시는 등록 스트리머 전체에만 적용하며, 풍투 호출은 LIVE 대상에게만 한다.

## 5. PostgreSQL 모델

월이 바뀌면 풍투 월간 누적값이 리셋되므로 모든 별풍선 값에는 `year`, `month`
가 필요하다.

### `streamer_month_current`

스트리머·월별 최신 상태를 한 건씩 보관한다.

```text
streamer_id              PK 일부
year, month              PK 일부
monthly_balloons
daily_balloons_json
fans_json
source                   detail | chart_ranking
source_observed_at       풍투 응답을 받은 시각
last_collected_at
last_changed_at
live_status
broadcast_id             nullable
consecutive_failures
```

### `streamer_month_history`

값 변화 또는 이상 상태만 기록한다.

```text
id
streamer_id
year, month
previous_balloons
current_balloons
delta
event_type               increase | regression | source_error | recovery
source_observed_at
detected_at
raw_summary_json         선택 사항
```

### `ranking_cache`

```text
cache_key                PK, 'current'
payload_json             기존 result.json 호환 응답
generated_at
source_max_observed_at
```

### 보존 정책

- `streamer_month_current`: 현재 월과 직전 2개월만 유지한다.
- `streamer_month_history`: `detected_at` 기준 90일 초과 행을 매일 삭제한다.
- `ranking_cache`: 항상 최신 한 건만 유지한다.

## 6. Collector 동작

### 6.1 라이브 감시

1. 등록 스트리머의 LIVE/OFF 상태를 **2분 간격 + 랜덤 지터**로 확인한다.
2. `OFF → LIVE` 전환 시 즉시 풍투를 1회 수집한다.
3. `LIVE → OFF` 전환 시 풍투를 마지막으로 1회 수집한 뒤 대상에서 제거한다.
4. 상태 조회 실패는 OFF로 판단하지 않고 마지막 정상 상태를 유지한다.

초기에는 전체 등록 스트리머 88명에 대해 1분 간격 감시를 하지 않는다.
원천 API 응답과 요청 한도를 관찰한 뒤 필요하면 간격을 줄인다.

### 6.2 가변 풍투 수집

| 상태 | 조건 | 풍투 조회 간격 |
|---|---|---:|
| HOT | 최근 조회에서 금액 변화 | 1분 |
| WARM | 10분 안에 변화가 있었음 | 3분 |
| COLD | 10분 이상 변화 없음 | 10분 |
| OFFLINE | LIVE 아님 | 중지 |

- API 오류/429/5xx에는 exponential backoff와 `Retry-After`를 적용한다.
- 모든 대상 요청을 같은 초에 실행하지 않는다.
- `detail/get` 실패 또는 일별 데이터가 비어 있으면 기존 `chart/get` 폴백을
  사용한다.

### 6.3 변경·회귀 처리

- 월간 별풍선 증가: `current` 갱신, `history` INSERT, 캐시 재생성.
- 동일 값: `last_collected_at`만 갱신.
- 값 감소: 일반 후원 변화로 저장하지 않는다. `regression` 이력으로 남기고
  직전 정상값을 유지한 뒤 다음 수집에서 재확인한다.
- 원천 응답이 정정되어 감소가 확정된 경우에만 명시적 보정 로직으로 반영한다.

### 6.4 재시작·복구

Worker 시작 시:

1. PostgreSQL의 `streamer_month_current`를 메모리에 로드한다.
2. 라이브 상태 감시를 시작한다.
3. 전일 또는 마지막 정상 수집 이후 방송이 있었던 대상은 강제 재수집한다.
4. 하루 1회 전체 대상 Recovery Sweep을 저속으로 실행한다.

여러 Worker가 동시에 실행되는 것을 막기 위해 PostgreSQL advisory lock 또는
`collector_lease` 테이블을 사용한다.

## 7. API 및 캐시

### `GET /api/result`

- `ranking_cache.cache_key = 'current'`의 JSON을 반환한다.
- 응답 형식은 기존 `result.json`과 호환되게 유지한다.
- `generated_at`, `source_max_observed_at`을 포함해 데이터 신선도를 화면에서
  표시할 수 있게 한다.

### Next.js 프로세스 캐시

DB의 ranking JSON을 읽은 뒤 Next.js 프로세스 메모리에 30~60초 캐시할 수 있다.
이는 보조 최적화이며, 재시작되어도 DB 캐시에서 즉시 복원된다.

권장 응답 헤더:

```text
Cache-Control: public, s-maxage=30, stale-while-revalidate=30
```

실시간성이 필요한 응답에 장시간 CDN 캐시를 적용하지 않는다.

## 8. 구현 단계와 완료 기준

### Phase 0 — 배포 안정화

- Cloudtype Next.js 배포를 완료한다.
- 기존 Google Sheets 기반 관리자 기능이 그대로 동작하는지 검증한다.
- 완료 기준: 메인, 관리자 로그인, 방명록, 가입신청, DB 명령 큐 기반 수동 갱신이 정상 동작.

### Phase 1 — PostgreSQL 기반 만들기

- PostgreSQL 서비스와 영구 디스크를 생성한다.
- 마이그레이션 도구와 스키마를 추가한다.
- Worker 첫 실행이 전체 수집으로 `ranking_cache`를 자동 생성한다.
- 완료 기준: `/api/result`가 DB 캐시 JSON을 동일 형식으로 반환.

### Phase 2 — Collector 분리

- `backend/main.py`의 수집 로직을 재사용 가능한 모듈로 분리한다.
- `backend/worker.py` 장기 실행 프로세스를 만든다.
- 데이터 원본 추상화(`MemberSource`)와 PostgreSQL repository를 구현한다.
- 완료 기준: Worker 재시작 후에도 DB 상태를 복원하고 중복 이력이 생기지 않음.

### Phase 3 — 라이브·가변 수집

- LIVE 감시, HOT/WARM/COLD 스케줄러, 지터, backoff를 추가한다.
- 월간 값 회귀 보호와 `chart/get` 폴백을 유지한다.
- 완료 기준: LIVE 시작·종료가 감지되고, LIVE 대상만 풍투를 요청함.

### Phase 4 — 복구·운영 도구

- Recovery Sweep, 90일 정리, 오류 기록, 관리 화면의 마지막 수집 시각을 추가한다.
- GitHub Actions와 파일 JSON 폴백은 사용하지 않는다.
- 완료 기준: Worker 중단·재시작 후 누락 의심 데이터를 복구할 수 있음.

## 9. 후속 전환 계획 — 운영 데이터와 3개월 화면

실시간 랭킹 전환(Phase 0~4)이 안정화된 뒤에만 진행한다. 이 단계는
Google Sheets를 즉시 제거하지 않는다는 초기 범위를 확장하는 작업이므로,
**이관 검증 전에는 기존 시트를 삭제하거나 환경변수를 제거하지 않는다.**

### Phase 5 — 3개월 랭킹 보관·조회

1. Collector는 현재 월·직전 2개월을 PostgreSQL에 유지한다.
2. 첫 적용 시 부족한 과거 두 달은 저속 백필(backfill)로 한 번 채운다.
3. `GET /api/result?year=YYYY&month=M`은 선택 월의 캐시를 반환한다.
4. 메인 타이틀 우측에는 최근 3개월 월 선택기를 둔다. 현재 월은 가장 크게,
   나머지는 작게 표시한다.

완료 기준: 예를 들어 9월에는 7·8·9월이 모두 DB에서 조회되고, 월 선택은
브라우저에서 원천 API를 호출하지 않는다.

### Phase 6 — Google Sheets 운영 데이터 일회 이관

이관 대상은 다음 다섯 가지다.

- 등록 멤버와 메모/휴직 상태
- 크루와 대표자 정보
- 관리자 계정과 권한
- 가입·휴직·복직·퇴사 신청 이력
- FA 방명록 및 투표 정보

절차:

1. PostgreSQL에 운영 테이블을 생성한다.
2. 관리자 전용 일회 이관 명령으로 시트 데이터를 UPSERT한다.
3. 원본·DB의 항목 수와 핵심 키를 비교해 이관 결과를 기록한다.
4. 회원·크루·관리자·신청·방명록 API를 PostgreSQL repository로 교체한다.
5. 실제 CRUD가 DB만 사용하는 것을 확인한 뒤 Google 환경변수를 제거한다.

초기 최고 관리자는 `admin`으로 만들고, 임시 비밀번호는 첫 로그인 직후 변경하게
한다. 실제 비밀번호는 해시로만 저장한다.

### Phase 7 — 관리자 운영 기능

- 관리자는 자신의 비밀번호를 변경할 수 있다.
- 최고 관리자는 크루명과 대표자명을 입력해 크루를 추가할 수 있다.
- 새 크루는 즉시 관리자 권한·멤버 추가·공개 가입 신청 목록에 반영된다.

### Phase 8 — 자동 배포

1. Next.js와 Collector 각각의 Cloudtype CLI가 생성한 GitHub Actions YAML을 사용한다.
2. GitHub에는 `CLOUDTYPE_TOKEN`, `GHP_TOKEN`만 Actions Secret으로 등록한다.
3. `main` 반영 시 변경 경로에 따라 Next.js, Collector를 각각 자동 배포한다.
4. PostgreSQL은 데이터 서비스이므로 코드 푸시마다 재배포하지 않는다.

### Phase 5 — Google Sheets CRUD 이전 (별도 과제)

- 관리자 화면 기능이 충분히 갖춰진 뒤 회원·방명록·가입신청을 PostgreSQL로
  이전한다.
- 이 단계 전까지 Google Sheets CRUD를 건드리지 않는다.

## 9. 운영 지표

다음 값은 로그와 관리자 화면에 남긴다.

- LIVE 감지 대상 수, 풍투 요청 수, 요청 성공률
- 스트리머별 마지막 정상 수집 시각
- 풍투 응답의 마지막 관측 시각과 화면 캐시 생성 시각
- API 429/5xx 횟수와 backoff 상태
- 값 회귀 건수와 보정 여부
- PostgreSQL 메모리·디스크 사용량

실시간성 목표는 “화면 값이 풍투 원천 값보다 1분 이내에 늦는다”로 정의한다.
풍투 원천 자체가 늦게 갱신되는 시간은 별도 지표로 분리한다.

## 10. 시작 전 체크리스트

- [ ] Cloudtype Hobby 구독: 메모리 1.5GB, 디스크 10GB
- [ ] Next.js, Collector, PostgreSQL을 각각 구독 리소스로 배포
- [ ] PostgreSQL 비밀번호와 연결 문자열을 Cloudtype 시크릿으로 등록
- [ ] Google 서비스 계정 및 기존 환경변수를 Cloudtype 시크릿으로 등록
- [ ] 원천 Google API가 복구되면 URL·인증·응답 예시를 문서화
- [ ] `result.json` 기존 응답과 DB 캐시 응답의 호환성 테스트
- [ ] API 사용량과 오류율을 확인한 뒤 실제 수집 간격 확정
