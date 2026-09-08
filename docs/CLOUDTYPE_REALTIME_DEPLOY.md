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
DATABASE_URL=postgresql://사용자:비밀번호@postgres-서비스-내부주소:5432/데이터베이스명
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
```

수집기는 외부 HTTP 요청만 하므로 도메인과 Health Check는 필요 없다. 공개 포트를
열지 않는다.

## 5. DB 초기화와 첫 수집

Collector를 배포하면 기본 명령인 `python realtime_worker.py`가 스키마를 자동으로
만든다. DB 캐시가 비어 있으면 첫 1회만 전체 대상을 수집하고, 이후에는 라이브 감시만
수행한다. 별도 JSON 초기 적재 명령은 없다.

## 6. 확인 기준

1. Collector 로그에 `Cycle saved`가 반복 표시된다.
2. 방송 중인 대상이 있을 때 `live refreshes=1` 이상이 기록된다.
3. Next.js `/api/result` 응답 헤더가 `X-Naksoo-Data-Source: postgres`가 된다.
4. 메인 화면의 초기 로딩에서 GitHub raw JSON 요청이 없다.

## 운영 메모

- 풍투 원천 API 자체가 늦게 갱신하면 1분 폴링이어도 값이 바로 오르지 않을 수 있다.
  이 시스템은 그 지연을 없애기보다, 원천이 갱신된 뒤 화면 반영 지연을 줄인다.
- 월간 총액이 이전보다 작게 오면 DB는 높은 기존 값은 유지하고 `regression` 이력만
  남긴다.
- `streamer_month_current`은 현재월 포함 3개월, `streamer_month_history`는 90일만
  유지한다.
