# main.py

import asyncio
import csv
import json
import shutil
from io import StringIO
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path

import httpx


# =========================
# 기본 설정
# =========================

# 구글시트 CSV 주소
SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/1w-hCArIqriowgLawxlAwZ1xOmGvGw32ics0ZGRHmwQs/export?format=csv"

# 결과 JSON 저장 폴더
OUTPUT_DIR = Path("data")

# 한국 시간 기준
TIMEZONE = ZoneInfo("Asia/Seoul")

# 풍투 API 요청 시 사용할 브라우저 헤더
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json,text/plain,*/*",
    "Referer": "https://poong.today/",
    "Origin": "https://poong.today",
}


# =========================
# 현재월 / 이전달 계산
# =========================

def get_current_and_previous_month():
    """
    현재 날짜 기준으로 현재월과 이전달을 계산한다.
    예:
    현재가 2026년 4월이면
    current = 2026년 4월
    previous = 2026년 3월
    """

    now = datetime.now(TIMEZONE)

    current_year = now.year
    current_month = now.month

    if current_month == 1:
        previous_year = current_year - 1
        previous_month = 12
    else:
        previous_year = current_year
        previous_month = current_month - 1

    return {
        "now": now,
        "current": {
            "year": current_year,
            "month": current_month,
        },
        "previous": {
            "year": previous_year,
            "month": previous_month,
        },
    }


# =========================
# 구글시트 CSV 읽기
# =========================

async def fetch_google_sheet_members():
    """
    구글시트 CSV에서 크루명과 user_id 목록을 가져온다.

    구글시트 컬럼 구조:
    crew_name,user_id
    광우상사,pms999
    씨나인,abc123
    """

    async with httpx.AsyncClient(
        follow_redirects=True,
        timeout=10,
        headers=HEADERS,
    ) as client:
        res = await client.get(SHEET_CSV_URL)
        res.raise_for_status()

    reader = csv.DictReader(StringIO(res.text))

    members = []

    for row in reader:
        crew_name = row.get("crew_name", "").strip()
        user_id = row.get("user_id", "").strip()

        # 빈 행은 무시
        if not crew_name or not user_id:
            continue

        members.append({
            "crew_name": crew_name,
            "user_id": user_id,
        })

    return members


# =========================
# 풍투 station API 호출
# =========================

async def fetch_station(client, user_id):
    """
    station API에서 BJ 기본 정보를 가져온다.

    가져올 정보:
    - user_id
    - user_nick
    - profile_image
    """

    url = f"https://static.poong.today/sooplive/api/{user_id}/station"

    res = await client.get(url)

    if res.status_code != 200:
        raise RuntimeError(f"station 실패: {user_id} {res.status_code}")

    data = res.json()
    station = data.get("station", {})

    return {
        "user_id": station.get("user_id") or user_id,
        "nickname": station.get("user_nick"),
        "profile_image_url": data.get("profile_image"),
    }


# =========================
# 풍투 별풍선 API 호출
# =========================

async def fetch_balloon(client, user_id, year, month):
    """
    풍투 detail/get API에서 월간 별풍선 데이터를 가져온다.

    주요 데이터:
    - b: 해당 월 전체 별풍선
    - d: 날짜별 별풍선 배열
    """

    url = (
        "https://static.poong.today/bj/detail/get"
        f"?id={user_id}&year={year}&month={month}"
    )

    res = await client.get(url)

    if res.status_code != 200:
        raise RuntimeError(
            f"balloon 실패: {user_id} {year}-{month} {res.status_code}"
        )

    return res.json()


# =========================
# 재시도 함수
# =========================

async def retry(coro_factory, retries=3, delay=1):
    """
    API 호출이 일시적으로 실패할 수 있으므로 재시도한다.
    예:
    1차 실패 → 1초 대기
    2차 실패 → 2초 대기
    3차 실패 → 최종 실패 처리
    """

    last_error = None

    for attempt in range(1, retries + 1):
        try:
            return await coro_factory()
        except Exception as e:
            last_error = e
            print(f"재시도 {attempt}/{retries} 실패:", e)
            await asyncio.sleep(delay * attempt)

    raise last_error


# =========================
# 별풍선 데이터 추출
# =========================

def extract_total_balloons(balloon_data):
    """
    풍투 API의 b 값을 월간 전체 별풍선으로 사용한다.
    """

    if not isinstance(balloon_data, dict):
        return 0

    return int(balloon_data.get("b") or 0)


def extract_daily_balloons(balloon_data):
    """
    풍투 API의 d 배열을 날짜별 별풍선 데이터로 변환한다.
    """

    if not isinstance(balloon_data, dict):
        return []

    daily = balloon_data.get("d", [])

    result = []

    for item in daily:
        result.append({
            "day": int(item.get("d") or 0),
            "balloons": int(item.get("b") or 0),
        })

    return result


def build_month_data(balloon_data, year, month):
    """
    특정 월의 별풍선 데이터를 정리한다.
    """

    return {
        "year": year,
        "month": month,
        "total_balloons": extract_total_balloons(balloon_data),
        "daily_balloons": extract_daily_balloons(balloon_data),
    }


# =========================
# 멤버 1명 데이터 가져오기
# =========================

async def fetch_one_member(client, member, period, semaphore):
    """
    구글시트에 있는 멤버 1명에 대해:
    1. station API로 닉네임 / 프로필 이미지 가져오기
    2. 현재월 별풍선 가져오기
    3. 이전달 별풍선 가져오기
    4. 하나의 객체로 합치기
    """

    async with semaphore:
        user_id = member["user_id"]
        crew_name = member["crew_name"]

        current_year = period["current"]["year"]
        current_month = period["current"]["month"]

        previous_year = period["previous"]["year"]
        previous_month = period["previous"]["month"]

        try:
            # BJ 기본 정보 가져오기
            station_data = await retry(
                lambda: fetch_station(client, user_id),
                retries=3,
                delay=1,
            )

            # 요청 간격 조절
            await asyncio.sleep(0.5)

            # 현재월 별풍선 데이터 가져오기
            current_balloon_data = await retry(
                lambda: fetch_balloon(
                    client,
                    user_id,
                    current_year,
                    current_month,
                ),
                retries=3,
                delay=1,
            )

            # 요청 간격 조절
            await asyncio.sleep(0.5)

            # 이전달 별풍선 데이터 가져오기
            previous_balloon_data = await retry(
                lambda: fetch_balloon(
                    client,
                    user_id,
                    previous_year,
                    previous_month,
                ),
                retries=3,
                delay=1,
            )

            return {
                "crew_name": crew_name,
                "user_id": station_data.get("user_id") or user_id,
                "nickname": station_data.get("nickname"),
                "profile_image_url": station_data.get("profile_image_url"),

                "current_month": build_month_data(
                    current_balloon_data,
                    current_year,
                    current_month,
                ),

                "previous_month": build_month_data(
                    previous_balloon_data,
                    previous_year,
                    previous_month,
                ),

                "success": True,
            }

        except Exception as e:
            # 특정 멤버만 실패해도 전체 프로그램이 죽지 않도록 처리
            print("멤버 조회 실패:", user_id, e)

            return {
                "crew_name": crew_name,
                "user_id": user_id,
                "nickname": None,
                "profile_image_url": None,

                "current_month": {
                    "year": current_year,
                    "month": current_month,
                    "total_balloons": 0,
                    "daily_balloons": [],
                },

                "previous_month": {
                    "year": previous_year,
                    "month": previous_month,
                    "total_balloons": 0,
                    "daily_balloons": [],
                },

                "success": False,
                "error": str(e),
            }


# =========================
# 백업 파일 이름 생성
# =========================

def make_output_filename(now):
    """
    백업용 JSON 파일명을 만든다.
    예:
    naksoo_2026-04-28_01-30-00.json
    """

    return now.strftime("naksoo_%Y-%m-%d_%H-%M-%S.json")


# =========================
# 최신 백업 찾기
# =========================

def get_latest_backup_file():
    """
    data 폴더 안에서 가장 최근에 생성된 백업 JSON 파일을 찾는다.
    result.json은 제외하고 naksoo_*.json만 찾는다.
    """

    files = list(OUTPUT_DIR.glob("naksoo_*.json"))

    if not files:
        return None

    return max(files, key=lambda file: file.stat().st_mtime)


# =========================
# 실패 시 최신 백업 복구
# =========================

def restore_latest_backup():
    """
    API 패치가 전체 실패했을 때,
    가장 최신 백업 파일을 result.json으로 복사한다.
    """

    latest_backup = get_latest_backup_file()

    if latest_backup is None:
        print("백업 파일 없음")
        return False

    result_path = OUTPUT_DIR / "result.json"

    shutil.copyfile(latest_backup, result_path)

    print(f"최신 백업 복구 완료: {latest_backup} → {result_path}")

    return True


# =========================
# 결과 JSON 저장
# =========================

def save_result_json(output, now):
    """
    패치 성공 시:
    1. 날짜/시간이 들어간 백업 JSON 생성
    2. Next.js가 읽을 고정 파일 result.json 생성
    """

    filename = make_output_filename(now)

    backup_path = OUTPUT_DIR / filename
    result_path = OUTPUT_DIR / "result.json"

    with open(backup_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    with open(result_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"백업 저장 완료: {backup_path}")
    print(f"result.json 저장 완료: {result_path}")


# =========================
# 백업이 하나도 없을 때 최소 result.json 생성
# =========================

def create_empty_result_json(now, error_message):
    """
    첫 실행부터 실패해서 백업 파일도 없을 때
    최소한의 result.json을 생성한다.
    """

    fallback = {
        "project": "naksoo",
        "created_at": now.isoformat(),
        "created_date": now.strftime("%Y-%m-%d"),
        "created_time": now.strftime("%H:%M:%S"),
        "timezone": "Asia/Seoul",
        "error": error_message,
        "count": 0,
        "items": [],
    }

    result_path = OUTPUT_DIR / "result.json"

    with open(result_path, "w", encoding="utf-8") as f:
        json.dump(fallback, f, ensure_ascii=False, indent=2)

    print(f"빈 result.json 생성 완료: {result_path}")


# =========================
# 메인 실행 함수
# =========================

async def main():
    """
    전체 실행 흐름:

    1. 현재월 / 이전달 계산
    2. 구글시트에서 멤버 목록 가져오기
    3. 풍투 API에서 멤버별 정보 가져오기
    4. JSON 구조로 정리
    5. 성공하면 백업 JSON + result.json 저장
    6. 전체 실패하면 최신 백업을 result.json으로 복구
    """

    period = get_current_and_previous_month()
    now = period["now"]

    OUTPUT_DIR.mkdir(exist_ok=True)

    try:
        # 구글시트에서 멤버 목록 가져오기
        members = await fetch_google_sheet_members()
        print(f"시트 멤버 수: {len(members)}명")

        if not members:
            raise RuntimeError("구글시트에서 멤버를 가져오지 못함")

        # 동시에 너무 많은 요청을 보내지 않도록 제한
        semaphore = asyncio.Semaphore(2)

        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=15,
            headers=HEADERS,
        ) as client:
            tasks = [
                fetch_one_member(client, member, period, semaphore)
                for member in members
            ]

            items = await asyncio.gather(*tasks)

        # 모든 멤버가 실패했으면 전체 실패로 판단
        all_failed = all(not item["success"] for item in items)

        if all_failed:
            raise RuntimeError("풍투 API 전체 실패")

        # 크루명 기준 정렬, 같은 크루 안에서는 현재월 별풍선 많은 순으로 정렬
        items.sort(
            key=lambda x: (
                x["crew_name"],
                -x["current_month"]["total_balloons"],
            )
        )

        # 최종 JSON 구조
        output = {
            "project": "naksoo",
            "created_at": now.isoformat(),
            "created_date": now.strftime("%Y-%m-%d"),
            "created_time": now.strftime("%H:%M:%S"),
            "timezone": "Asia/Seoul",

            "current_period": period["current"],
            "previous_period": period["previous"],

            "count": len(items),
            "items": items,
        }

        # 성공 시 백업 JSON과 result.json 둘 다 저장
        save_result_json(output, now)

    except Exception as e:
        # 전체 실패 시 최신 백업으로 result.json 복구
        print("패치 실패")
        print("에러:", e)
        print("최신 백업으로 result.json 복구 시도")

        restored = restore_latest_backup()

        # 백업도 없으면 빈 result.json 생성
        if not restored:
            create_empty_result_json(now, str(e))


# =========================
# 프로그램 시작점
# =========================

if __name__ == "__main__":
    asyncio.run(main())