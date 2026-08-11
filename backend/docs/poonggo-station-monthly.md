# poonggo station 월간 HTML 매핑

poonggo station 월간 통계 페이지를 기존 `result.json` 월 객체로 변환하는 규칙입니다.
기본 데이터 소스는 풍투(`bj/detail/get`)이며, poonggo는 `NAKSOO_ENABLE_POONGGO_FALLBACK=1`일 때만 사용합니다.

## URL

```
https://poonggo.com/station/{user_id}?c=monthly&date={year}-{month}-01&page=1&tab=1
```

## 필드 매핑

| poonggo HTML | 저장 필드 |
|---|---|
| `별풍선 합계` 카드의 `h3` 텍스트 | `total_balloons` |
| 팬랭킹 닉네임 | `fans[].nickname` |
| 팬랭킹 user id | `fans[].user_id` |
| 팬랭킹 첫 번째 숫자 컬럼 | `fans[].balloons` |

`avg_balloons`는 기존 풍투 매핑처럼 `balloons / count` 정수값으로 계산합니다.

## 일별 데이터

월간 페이지에는 기존 풍투 `d[]`에 해당하는 일별 배열이 없습니다. 따라서 poonggo 월간 HTML 소스의 `daily_balloons`는 빈 배열로 저장합니다.
