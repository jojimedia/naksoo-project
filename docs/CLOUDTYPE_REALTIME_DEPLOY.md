# Cloudtype PostgreSQL·실시간 수집기 배포 순서

이 순서는 기존 Next.js 서비스가 이미 Cloudtype에 배포되어 있고, 계정이
Hobby 이상으로 전환된 상태를 기준으로 한다. 기존 Google Sheets 관리자 기능은
그대로 둔다.

## 1. 리소스 배정

Cloudtype 구독 리소스에서 다음을 배정한다.

| 대상 | 메모리 | 디스크 |
|---|---:|---:|
| 기존 Next.js 서비스 | 0.5GB | 없음 |
| 새 Python Collector 서비스 | 0.5GB | 없음 |
| 새 PostgreSQL 서비스 | 0.5GB | 10GB |

CPU는 구독하지 않고 기본 공유 CPU로 시작한다. 트래픽 초과 처리도 처음에는
`중지`로 둔다. PostgreSQL의 영구 디스크만 별도 구독이 필요하다.

## 2. PostgreSQL 서비스 만들기

1. Cloudtype 프로젝트에서 `서비스 추가` → `PostgreSQL`을 선택한다.
2. 위 표처럼 `0.5GB 메모리`, `10GB 영구 디스크`를 연결해 생성한다.
3. 서비스의 **내부 연결 주소** 또는 Cloudtype이 제공하는 `DATABASE_URL`을 복사한다.
   외부 공개 주소가 아니라 같은 프로젝트 서비스끼리 통신하는 내부 주소를 쓴다.
4. 아래 두 서비스의 환경변수에 같은 값을 추가한다.

```text
DATABASE_URL=postgresql://root:비밀번호@postgresql:5432/postgres
```

`DATABASE_URL`은 비밀값이다. GitHub 저장소, 브라우저 코드, `NEXT_PUBLIC_` 환경변수에
넣으면 안 된다.

## 3. Next.js 서비스에 DB 연결

기존 `naksoo` Next.js 서비스의 환경변수에 `DATABASE_URL`만 추가한 뒤 재배포한다.

- 기존 환경변수는 그대로 유지한다.
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `ADMIN_SESSION_SECRET`도 계속 비밀값으로 둔다.
- `GITHUB_ACTIONS_TOKEN`, `GITHUB_REPO`, `GITHUB_DATA_REF`는 제거한다.

배포 후 다음 주소가 JSON을 돌려주는지 확인한다.

```text
https://기존-서비스-주소/api/result
```

DB 캐시가 준비되기 전에는 `503 ranking_cache_not_ready`가 정상이다. Worker 첫 실행이
전체 데이터를 자동 수집해 캐시를 만든다.

## 4. Python Collector 서비스 만들기

1. `서비스 추가` → GitHub 저장소 `jojimedia/naksoo-project` → `main`을 고른다.
2. **서브 디렉터리**를 `backend`로 입력한다.
3. 빌드 방식은 `Dockerfile`을 선택한다. 저장소에 추가된 `backend/Dockerfile`이
   `realtime_worker.py`를 상시 실행한다.
4. 메모리는 `0.5GB`를 연결한다.
5. 환경변수를 추가한다.

```text
DATABASE_URL=<2단계에서 복사한 내부 연결 주소>
NAKSOO_STATUS_POLL_SECONDS=120
NAKSOO_HOT_POLL_SECONDS=60
NAKSOO_WARM_POLL_SECONDS=180
NAKSOO_COLD_POLL_SECONDS=600
NAKSOO_WORKER_LOOP_SECONDS=10
NAKSOO_POONGGO_RECONCILE_SECONDS=90
NAKSOO_LIVE_FLUSH_SECONDS=2
```

Collector는 Dockerfile의 8000번 포트에서 FastAPI를 함께 실행한다. Health Check
경로는 `/health`, 읽기 전용 실시간 엔드포인트는 `/live/events`, 재접속 스냅샷은
`/live/snapshot`이다.

Next.js의 `/api/live/events`가 같은 배포환경의 내부 서비스 주소
`http://naksoo-collector:8000`을 프록시하므로 Collector 공개 도메인과 CORS 설정은
필요 없다. 서비스명을 바꾼 경우에만 Next.js 서비스에 아래 서버 전용 환경변수를
추가한다.

```text
NAKSOO_LIVE_INTERNAL_URL=http://변경한-Collector-서비스명:8000
```

## 5. DB 초기화와 첫 수집

Collector를 배포하면 기본 명령인 `python realtime_worker.py`가 스키마를 자동으로
만든다. DB 캐시가 비어 있으면 첫 1회 전체 대상을 수집한다. 이후에는 라이브 대상은
1~1.5분마다 갱신하고, 전체 활성 멤버의 현재월 풍투 합계는 수집기 재시작 직후와 기본
2시간마다 보정한다. 관리자 화면의 **데이터 갱신** 요청은 이 전체 대조를 즉시 실행한다.
이전 월 데이터는 다시 수집하지 않으며, 별도 JSON 초기 적재 명령도 없다.

## 6. 확인 기준

1. Collector 로그에 `Cycle saved`가 반복 표시된다.
2. Collector `/health`에서 `live_streams`와 `connected_streams`가 확인된다.
3. Next.js `/api/result` 응답 헤더가 `X-Naksoo-Data-Source: postgres`가 된다.
4. 브라우저 네트워크에서 `/live/events`가 `text/event-stream`으로 유지된다.
5. 메인 화면의 초기 로딩에서 GitHub raw JSON 요청이 없다.

## 운영 메모

- 풍투는 전체 멤버의 저부하 기준값으로 유지한다. 라이브 멤버는 풍고 일간·월간
  스냅샷으로 시작하고 풍고 SSE 후원을 즉시 합산한다.
- 풍고 SSE 이벤트는 메모리에서 바로 프론트로 전달한다. PostgreSQL에는 2초 단위로
  합계·오늘 후원자 목록과 원본 이벤트 ID를 묶어 저장하며, 같은 이벤트 ID는 한 번만
  반영한다.
- SSE 연결이 끊기거나 수집기가 재시작되면 풍고 일간·월간 스냅샷을 즉시 읽고,
  라이브 중에는 기본 90초마다 누락을 보정한다.
- `streamer_month_current`은 현재월 포함 3개월, `streamer_month_history`는 90일만
  유지한다.
