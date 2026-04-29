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

# 풍투 API 요청용 헤더
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
    """현재 날짜 기준으로 현재월과 이전달을 계산한다."""

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
    """구글시트 CSV에서 crew_name, user_id 목록을 가져온다."""

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
# station API
# =========================

async def fetch_station(client, user_id):
    """
    SOOPTV station API에서 기본 정보를 가져온다.
    - user_id
    - user_nick
    - profile_image
    """

    url = f"https://api-channel.sooplive.com/v1.1/channel/{user_id}/station"

    res = await client.get(url)

    if res.status_code != 200:
        raise RuntimeError(f"station 실패: {user_id} {res.status_code}")

    data = res.json()
    station = data.get("station", {})

    return {
        "user_id": station.get("userId") or user_id,
        "nickname": station.get("userNick"),
        "profile_image_url": station.get("profileImage"),
        "broadcast_start": station.get("broadStart"),
    }


async def fetch_live_status(client, user_id):
    """SOOPTV 생방송 정보 API에서 현재 공개 방송 중 여부를 가져온다."""

    url = "https://live.sooplive.co.kr/afreeca/player_live_api.php"
    payload = {
        "bid": user_id,
        "from_api": "0",
        "mode": "landing",
        "player_type": "html5",
    }

    res = await client.post(
        url,
        data=payload,
        headers={
            **HEADERS,
            "Origin": "https://live.sooplive.co.kr",
            "Referer": f"https://live.sooplive.co.kr/{user_id}",
        },
    )

    if res.status_code != 200:
        raise RuntimeError(f"live status 실패: {user_id} {res.status_code}")

    channel = res.json().get("CHANNEL", {})

    return {
        "is_live": channel.get("RESULT") == 1 and channel.get("BPWD") != "Y",
        "is_password": channel.get("BPWD") == "Y",
    }


# =========================
# 풍투 별풍선 API
# =========================

async def fetch_balloon(client, user_id, year, month):
    """
    풍투 detail/get API에서 월간 별풍선 데이터를 가져온다.
    - b: 월 전체 별풍선
    - d: 날짜별 별풍선
    - f: 팬 / 큰손 목록
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
    """API 호출 실패 시 지정 횟수만큼 재시도한다."""

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
    """풍투 API의 b 값을 월간 전체 별풍선으로 사용한다."""

    if not isinstance(balloon_data, dict):
        return 0

    return int(balloon_data.get("b") or 0)


def extract_daily_balloons(balloon_data):
    """풍투 API의 d 배열을 날짜별 별풍선 데이터로 변환한다."""

    if not isinstance(balloon_data, dict):
        return []

    result = []

    for item in balloon_data.get("d", []):
        result.append({
            "day": int(item.get("d") or 0),
            "balloons": int(item.get("b") or 0),
        })

    return result


def extract_fans(balloon_data, limit=50):
    """
    풍투 API의 f 배열을 팬 / 큰손 목록으로 변환한다.

    원본 구조:
    i = 후원자 user_id
    n = 후원자 닉네임
    b = 별풍선 수
    c = 후원 횟수
    """

    if not isinstance(balloon_data, dict):
        return []

    result = []

    for fan in balloon_data.get("f", [])[:limit]:
        balloons = int(fan.get("b") or 0)
        count = int(fan.get("c") or 0)

        result.append({
            "user_id": fan.get("i"),
            "nickname": fan.get("n"),
            "balloons": balloons,
            "count": count,
            "avg_balloons": int(balloons / count) if count else 0,
        })

    return result


async def fetch_fan_profile(client, user_id, fan_profile_cache):
    """SOOPTV station API에서 후원자 최신 닉네임/프로필을 가져온다."""

    if not user_id:
        return None

    if user_id in fan_profile_cache:
        return fan_profile_cache[user_id]

    try:
        station_data = await retry(
            lambda: fetch_station(client, user_id),
            retries=2,
            delay=0.5,
        )
        profile = {
            "nickname": station_data.get("nickname"),
            "profile_image_url": station_data.get("profile_image_url"),
        }
    except Exception:
        profile = None

    fan_profile_cache[user_id] = profile

    return profile


async def enrich_fans_with_profiles(client, fans, fan_profile_cache):
    """화면에 노출될 팬 목록에 최신 닉네임/프로필을 채운다."""

    enriched = []

    for fan in fans:
        profile = await fetch_fan_profile(
            client,
            fan.get("user_id"),
            fan_profile_cache,
        )

        enriched.append({
            **fan,
            "nickname": profile.get("nickname") if profile else fan.get("nickname"),
            "profile_image_url": (
                profile.get("profile_image_url") if profile else None
            ),
        })

    return enriched


def build_month_data(balloon_data, year, month):
    """특정 월의 별풍선 데이터를 하나의 객체로 정리한다."""

    return {
        "year": year,
        "month": month,
        "total_balloons": extract_total_balloons(balloon_data),
        "daily_balloons": extract_daily_balloons(balloon_data),
        "fans": extract_fans(balloon_data),
    }


# =========================
# 멤버 1명 데이터 가져오기
# =========================

async def fetch_one_member(client, member, period, semaphore, fan_profile_cache):
    """
    구글시트 멤버 1명에 대해:
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

            await asyncio.sleep(0.5)

            live_status = await retry(
                lambda: fetch_live_status(client, user_id),
                retries=3,
                delay=1,
            )

            await asyncio.sleep(0.5)

            # 현재월 별풍 데이터 가져오기
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

            await asyncio.sleep(0.5)

            # 이전달 별풍 데이터 가져오기
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

            current_month_data = build_month_data(
                current_balloon_data,
                current_year,
                current_month,
            )
            current_month_data["fans"] = await enrich_fans_with_profiles(
                client,
                current_month_data["fans"],
                fan_profile_cache,
            )

            return {
                "crew_name": crew_name,
                "user_id": station_data.get("user_id") or user_id,
                "nickname": station_data.get("nickname"),
                "profile_image_url": station_data.get("profile_image_url"),
                "broadcast_start": (
                    station_data.get("broadcast_start")
                    if live_status["is_live"]
                    else None
                ),
                "is_live": live_status["is_live"],
                "is_password_broadcast": live_status["is_password"],

                "current_month": current_month_data,

                "previous_month": build_month_data(
                    previous_balloon_data,
                    previous_year,
                    previous_month,
                ),

                "success": True,
            }

        except Exception as e:
            # 특정 멤버만 실패해도 전체 프로그램이 멈추지 않게 처리
            print("멤버 조회 실패:", user_id, e)

            return {
                "crew_name": crew_name,
                "user_id": user_id,
                "nickname": None,
                "profile_image_url": None,
                "broadcast_start": None,
                "is_live": False,
                "is_password_broadcast": False,

                "current_month": {
                    "year": current_year,
                    "month": current_month,
                    "total_balloons": 0,
                    "daily_balloons": [],
                    "fans": [],
                },

                "previous_month": {
                    "year": previous_year,
                    "month": previous_month,
                    "total_balloons": 0,
                    "daily_balloons": [],
                    "fans": [],
                },

                "success": False,
                "error": str(e),
            }


# =========================
# 백업 파일 이름 생성
# =========================

def make_output_filename(now):
    """백업용 JSON 파일명을 만든다."""

    return now.strftime("naksoo_%Y-%m-%d_%H-%M-%S.json")


# =========================
# 최신 백업 찾기
# =========================

def get_latest_backup_file():
    """data 폴더에서 가장 최근 백업 JSON 파일을 찾는다."""

    files = list(OUTPUT_DIR.glob("naksoo_*.json"))

    if not files:
        return None

    return max(files, key=lambda file: file.stat().st_mtime)


# =========================
# 실패 시 최신 백업 복구
# =========================

def restore_latest_backup():
    """패치 전체 실패 시 최신 백업 파일을 result.json으로 복사한다."""

    latest_backup = get_latest_backup_file()

    if latest_backup is None:
        print("백업 파일 없음")
        return False

    result_path = OUTPUT_DIR / "result.json"

    shutil.copyfile(latest_backup, result_path)

    print(f"최신 백업 복구 완료: {latest_backup} → {result_path}")

    return True


# =========================
# 지난 날짜 백업 삭제
# =========================

def cleanup_old_backup_files(today_date):
    """
    오늘 날짜 백업만 남기고 지난 날짜 백업 JSON을 삭제한다.

    예:
    오늘이 2026-04-29라면
    naksoo_2026-04-29_*.json 파일만 유지한다.
    """

    today_prefix = f"naksoo_{today_date}"

    for file in OUTPUT_DIR.glob("naksoo_*.json"):
        if not file.name.startswith(today_prefix):
            file.unlink()
            print(f"지난 날짜 백업 삭제: {file}")


# =========================
# 결과 JSON 저장
# =========================

def save_result_json(output, now):
    """
    패치 성공 시:
    1. 날짜/시간이 들어간 백업 JSON 생성
    2. Next.js가 읽을 고정 파일 result.json 생성
    3. 오늘 날짜가 아닌 백업 JSON 삭제
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

    cleanup_old_backup_files(now.strftime("%Y-%m-%d"))


# =========================
# 백업이 하나도 없을 때 최소 result.json 생성
# =========================

def create_empty_result_json(now, error_message):
    """첫 실행부터 실패해서 백업 파일도 없을 때 최소 result.json을 생성한다."""

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
        members = await fetch_google_sheet_members()
        print(f"시트 멤버 수: {len(members)}명")

        if not members:
            raise RuntimeError("구글시트에서 멤버를 가져오지 못함")

        # 동시에 너무 많은 요청을 보내지 않도록 제한
        semaphore = asyncio.Semaphore(2)
        fan_profile_cache = {}

        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=15,
            headers=HEADERS,
        ) as client:
            tasks = [
                fetch_one_member(
                    client,
                    member,
                    period,
                    semaphore,
                    fan_profile_cache,
                )
                for member in members
            ]

            items = await asyncio.gather(*tasks)

        # 모든 멤버가 실패했으면 전체 실패로 판단
        all_failed = all(not item["success"] for item in items)

        if all_failed:
            raise RuntimeError("풍투 API 전체 실패")

        # 크루명 기준 정렬, 같은 크루 안에서는 현재월 별풍 많은 순 정렬
        items.sort(
            key=lambda x: (
                x["crew_name"],
                -x["current_month"]["total_balloons"],
            )
        )

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

        save_result_json(output, now)

    except Exception as e:
        print("패치 실패")
        print("에러:", e)
        print("최신 백업으로 result.json 복구 시도")

        restored = restore_latest_backup()

        if not restored:
            create_empty_result_json(now, str(e))


# =========================
# 프로그램 시작점
# =========================

if __name__ == "__main__":
    asyncio.run(main())
