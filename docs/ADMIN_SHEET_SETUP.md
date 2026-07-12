# 관리자 시트 설정 가이드

관리자 로그인·멤버 관리 기능을 사용하려면 **구글 시트를 직접 수정**하고 서비스 계정을 연결해야 합니다.  
코드를 배포해도 시트는 자동으로 바뀌지 않습니다.

스프레드시트: [members 시트](https://docs.google.com/spreadsheets/d/1w-hCArIqriowgLawxlAwZ1xOmGvGw32ics0ZGRHmwQs/edit)

## 1. members 탭 수정 (직접 해야 함)

현재 구조:

| crew_name | user_id | nickname |
|-----------|---------|----------|

**D열에 `note` 헤더를 추가**하세요:

| crew_name | user_id | nickname | note |
|-----------|---------|----------|------|
| 광우상사 | fall1128 | 가을이♡ | |
| GD컴퍼니 | example_id | 닉네임 | 휴직 |

- `note`가 `휴직`이면 크롤·점수 계산에서 제외됩니다.
- 멤버 삭제는 해당 행을 시트에서 제거합니다.
- 탭 이름이 `members`가 아니고 `시트1`이어도 동작합니다.

## 2. admins 탭 추가 (직접 해야 함)

시트 하단 **+** 로 새 탭을 만들고 이름을 `admins`로 바꾼 뒤:

| login_id | password | crews |
|----------|----------|-------|
| admin1 | secret123 | 광우상사,GD컴퍼니 |

- `crews`: 쉼표로 구분된 관리 가능 크루명 (시트의 `crew_name`과 정확히 일치)
- 비밀번호는 평문 저장 (서버에서만 검증)

## 3. 서비스 계정 설정

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트 생성
2. **Google Sheets API** 활성화
3. 서비스 계정 생성 후 JSON 키 다운로드
4. 스프레드시트를 서비스 계정 이메일에 **편집자**로 공유
5. Vercel(또는 로컬 `frontend/.env.local`)에 환경변수 등록:

```env
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-sa@project.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GOOGLE_SHEET_ID=1w-hCArIqriowgLawxlAwZ1xOmGvGw32ics0ZGRHmwQs
ADMIN_SESSION_SECRET=랜덤_32자_이상_문자열
```

선택:

```env
GOOGLE_MEMBERS_SHEET_NAME=시트1
GOOGLE_ADMINS_SHEET_NAME=admins
```

## 4. 동작 확인 순서

1. 시트에 `note` 컬럼 + `admins` 탭 수동 추가
2. 서비스 계정 공유 + Vercel 환경변수 등록 후 재배포
3. 사이트 헤더 **key 아이콘** → `admins` 탭 계정으로 로그인
4. 관리 패널에서 등록/삭제/휴직 → **그때부터** 시트가 변경됨

서비스 계정이 없으면 관리 API는 동작하지 않으며, 대시보드 조회는 기존과 동일합니다.

## 5. 개인 계정 노출

크루 관리자에게 **시트 링크를 주지 않고** 웹 관리 패널만 쓰면, 로그인한 사람이 당신 개인 구글 계정을 알 수 없습니다.
