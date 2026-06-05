# poonggo station 월간 HTML 매핑

poonggo station 월간 통계 페이지를 기존 `result.json` 월 객체로 변환하는 규칙입니다.

## 요청 URL

```
https://poonggo.com/station/{user_id}?c=monthly&date={year}-{month}-01&page=1&tab=1
```

## result.json 매핑

| poonggo HTML | 저장 필드 |
|----|----|
| `별풍선 합계` 카드의 `h3` 텍스트 | `total_balloons` |
| 팬랭킹 행의 SOOP station 링크 마지막 path | `fans[].user_id` |
| 팬랭킹 행의 링크 텍스트 | `fans[].nickname` |
| 팬랭킹 첫 번째 숫자 컬럼 | `fans[].balloons` |
| 팬랭킹 두 번째 숫자 컬럼 | `fans[].count` |

`avg_balloons`는 기존 풍투 매핑처럼 `balloons / count` 정수값으로 계산합니다.

## 제한

월간 페이지에는 기존 풍투 `d[]`에 해당하는 일별 배열이 없습니다. 따라서 poonggo 월간 HTML 소스의 `daily_balloons`는 빈 배열로 저장합니다.

기존 풍투 API 코드는 나중에 되살릴 수 있도록 보존하지만 기본 연결은 해제합니다.
`NAKSOO_ENABLE_POONGTODAY_FALLBACK=1`을 설정한 경우에만 poonggo 실패 후 `bj/detail/get` → `chart/get` 순서의 기존 경로를 사용합니다.
