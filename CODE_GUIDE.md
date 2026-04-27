# 코드 설명서

## 개요

이 프론트엔드는 크루별 스트리머 별풍 데이터를 보여주는 Next.js App Router 화면입니다. 현재 달 데이터와 지난 달 데이터를 함께 불러와 크루 순위, 개인 순위, 증감값, 지난 달 값을 표시합니다.

## 데이터 흐름

1. `app/page.tsx`에서 현재 달과 지난 달 크루 데이터를 동시에 요청합니다.
2. `app/lib/crew-data.ts`가 Next API route인 `/api/crews`를 호출합니다.
3. `app/api/crews/route.ts`가 백엔드 FastAPI `/crews/`로 요청을 프록시합니다.
4. 화면에서는 현재 달 별풍을 기준으로 스트리머를 정렬하고, 지난 달 데이터는 증감값 계산에만 사용합니다.

## 주요 파일

### `app/page.tsx`

페이지의 최상위 서버 컴포넌트입니다. 데이터 조회와 레이아웃 조립만 담당합니다.

- `getCrewData(4)`: 현재 달 데이터
- `getCrewData(3)`: 지난 달 데이터
- `PageHeader`: 상단 제목과 업데이트 버튼
- `CrewGrid`: 크루 카드 목록

### `app/types.ts`

공통 타입을 모아둔 파일입니다.

- `Streamer`: 스트리머별 ID, 닉네임, 별풍 수
- `Crew`: 크루 이름과 스트리머 목록
- `CrewHeaderTheme`: 카드 헤더 색상 테마

### `app/lib/crew-data.ts`

크루 데이터를 가져오는 서버 전용 유틸입니다. 서버 컴포넌트에서는 상대 경로 `/api/...`를 바로 쓰기 어렵기 때문에 요청 헤더의 `host`와 `x-forwarded-proto`로 현재 origin을 만든 뒤 `/api/crews`를 호출합니다.

### `app/lib/crew-stats.ts`

크루와 스트리머 계산 로직입니다.

- `getTotalBalloons`: 크루 전체 합계
- `getAverageBalloons`: 크루 평균 별풍
- `sortCrewsByAverage`: 평균 별풍 기준 크루 정렬
- `sortStreamersByBalloons`: 현재 달 별풍 기준 스트리머 정렬

### `app/lib/format.ts`

표시용 포맷 유틸입니다.

- `formatNumber`: 숫자 콤마 포맷
- `getProfileUrl`: SOOP 프로필 이미지 URL 생성

### `app/lib/themes.ts`

크루 카드 헤더 테마를 관리합니다. 색상은 크루 이름에 고정하지 않고 순위에 따라 순환합니다.

## 컴포넌트 구조

### `app/components/PageHeader.tsx`

페이지 상단의 로고, 제목, 업데이트 버튼을 렌더링합니다.

### `app/components/CrewGrid.tsx`

크루 목록 전체를 담당합니다. 지난 달 데이터를 `Map`으로 바꿔 각 스트리머의 이전 달 별풍을 빠르게 찾습니다.

### `app/components/CrewCard.tsx`

크루 카드 하나를 렌더링합니다.

- 크루명
- 카드 순위
- 전체 합계
- 평균 별풍
- 1등 스트리머 카드
- 나머지 스트리머 목록

### `app/components/TopStreamerCard.tsx`

크루 내 1등 스트리머를 강조 표시합니다. 일반 행보다 이름과 별풍 숫자가 크게 보이도록 구성되어 있습니다.

### `app/components/StreamerRow.tsx`

2등 이하 스트리머 행을 렌더링합니다. 현재 달 별풍, 지난 달 별풍, 증감값을 함께 표시합니다.

### `app/components/StatCard.tsx`

크루 카드 상단의 통계 박스입니다. 현재는 `전체 합계`, `평균 별풍`에 사용됩니다.

### `app/components/FormattedBalloon.tsx`

별풍 숫자에 콤마와 줄바꿈 방지 처리를 적용하는 작은 표시 컴포넌트입니다.

## 업데이트 버튼

`app/UpdateButton.tsx`는 클라이언트 컴포넌트입니다. 버튼 클릭 시 `/api/admin/update-data`를 호출하고, `/api/admin/last-updated`를 폴링해서 성공 여부를 확인합니다.

중요한 기준:

- 업데이트 실패 시 기존 DB 데이터가 남습니다.
- 실패 시 날짜는 바뀌지 않습니다.
- 날짜는 마지막으로 데이터 수집이 성공한 시각입니다.
- 화면에는 실패 문구를 표시하지 않습니다.

## API Route

### `app/api/crews/route.ts`

프론트 서버가 백엔드 `/crews/` API를 대신 호출합니다. 브라우저 CORS와 개발 서버 origin 문제를 줄이기 위한 프록시입니다.

### `app/api/admin/update-data/route.ts`

백엔드 `/admin/update-data`를 호출해 수집 작업을 시작합니다.

### `app/api/admin/last-updated/route.ts`

백엔드 `/admin/last-updated`를 호출해 마지막 성공 업데이트 시각과 업데이트 상태를 가져옵니다.

## 외부 이미지 처리

스트리머 프로필 이미지는 `next/image`가 아니라 일반 `<img>`를 사용합니다. SOOP 외부 이미지 도메인을 Next remote image 설정에 추가하지 않고도 바로 렌더링하기 위한 선택입니다. 이 때문에 ESLint의 `@next/next/no-img-element` 경고가 남아 있습니다.

## 검증 명령

```bash
npx tsc --noEmit
npx eslint app next.config.ts
```

현재 알려진 lint 경고는 외부 프로필 이미지 `<img>` 사용 경고입니다.
