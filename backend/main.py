# main.py

import asyncio
import csv
import json
import shutil
from collections import Counter
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

POONG_HEADERS = {
    **HEADERS,
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
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


def print_crawl_targets(members):
    """구글시트에서 읽은 크롤링 대상 목록을 출력한다."""

    print("크롤링 대상 목록")

    for index, member in enumerate(members, start=1):
        print(
            f"  {index:03d}. "
            f"{member['crew_name']} / {member['user_id']}"
        )


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
    """SOOPTV 생방송 정보 API에서 비번방 여부와 공개 방송 여부를 가져온다."""

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


def resolve_live_status(station_data, live_status):
    """
    19금 방송은 player API에서 시청 제한 응답으로 내려와 RESULT가 1이 아닐 수 있다.
    station API에 방송 시작 시간이 있고 비번방이 아니면 방송 중으로 본다.
    """

    if live_status["is_password"]:
        return False

    return live_status["is_live"] or bool(station_data.get("broadcast_start"))


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

    res = await client.get(url, headers=POONG_HEADERS)

    if res.status_code != 200:
        body_preview = res.text[:200].replace("\n", " ")
        raise RuntimeError(
            f"balloon 실패: {user_id} {year}-{month} "
            f"{res.status_code} body={body_preview!r}"
        )

    try:
        return res.json()
    except ValueError as e:
        body_preview = res.text[:200].replace("\n", " ")
        raise RuntimeError(
            f"balloon JSON 파싱 실패: {user_id} {year}-{month} "
            f"body={body_preview!r}"
        ) from e


# =========================
# 재시도 함수
# =========================

async def retry(coro_factory, retries=3, delay=1, label=None):
    """API 호출 실패 시 지정 횟수만큼 재시도한다."""

    last_error = None

    for attempt in range(1, retries + 1):
        try:
            return await coro_factory()
        except Exception as e:
            last_error = e
            prefix = f"[{label}] " if label else ""
            print(
                f"{prefix}재시도 {attempt}/{retries} 실패:",
                type(e).__name__,
                repr(e),
            )

            if attempt < retries:
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


async def fetch_fan_profile(
    client,
    user_id,
    fan_profile_cache,
    fan_profile_lock,
    fan_profile_semaphore,
):
    """SOOPTV station API에서 후원자 최신 닉네임/프로필을 가져온다."""

    if not user_id:
        return None

    async with fan_profile_lock:
        if user_id in fan_profile_cache:
            return fan_profile_cache[user_id]

    async with fan_profile_semaphore:
        async with fan_profile_lock:
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

        async with fan_profile_lock:
            fan_profile_cache[user_id] = profile

    return profile


async def enrich_fans_with_profiles(
    client,
    fans,
    fan_profile_cache,
    fan_profile_lock,
    fan_profile_semaphore,
):
    """화면에 노출될 팬 목록에 최신 닉네임/프로필을 채운다."""

    async def enrich_one(fan):
        profile = await fetch_fan_profile(
            client,
            fan.get("user_id"),
            fan_profile_cache,
            fan_profile_lock,
            fan_profile_semaphore,
        )

        return {
            **fan,
            "nickname": profile.get("nickname") if profile else fan.get("nickname"),
            "profile_image_url": (
                profile.get("profile_image_url") if profile else None
            ),
        }

    return await asyncio.gather(*(enrich_one(fan) for fan in fans))


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

async def fetch_one_member(
    client,
    member,
    period,
    semaphore,
    fan_profile_cache,
    fan_profile_lock,
    fan_profile_semaphore,
):
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
            print(f"[{crew_name}/{user_id}] 멤버 조회 시작")

            # BJ 기본 정보 가져오기
            print(f"[{crew_name}/{user_id}] station API 조회")
            station_data = await retry(
                lambda: fetch_station(client, user_id),
                retries=3,
                delay=1,
                label=f"{crew_name}/{user_id} station",
            )

            await asyncio.sleep(0.5)

            print(f"[{crew_name}/{user_id}] live status API 조회")
            live_status = await retry(
                lambda: fetch_live_status(client, user_id),
                retries=3,
                delay=1,
                label=f"{crew_name}/{user_id} live status",
            )

            await asyncio.sleep(0.5)

            # 현재월 별풍 데이터 가져오기
            print(
                f"[{crew_name}/{user_id}] 풍투 현재월 조회 "
                f"{current_year}-{current_month}"
            )
            current_balloon_data = await retry(
                lambda: fetch_balloon(
                    client,
                    user_id,
                    current_year,
                    current_month,
                ),
                retries=8,
                delay=2,
                label=(
                    f"{crew_name}/{user_id} "
                    f"balloon {current_year}-{current_month}"
                ),
            )

            await asyncio.sleep(0.5)

            # 이전달 별풍 데이터 가져오기
            print(
                f"[{crew_name}/{user_id}] 풍투 이전달 조회 "
                f"{previous_year}-{previous_month}"
            )
            previous_balloon_data = await retry(
                lambda: fetch_balloon(
                    client,
                    user_id,
                    previous_year,
                    previous_month,
                ),
                retries=8,
                delay=2,
                label=(
                    f"{crew_name}/{user_id} "
                    f"balloon {previous_year}-{previous_month}"
                ),
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
                fan_profile_lock,
                fan_profile_semaphore,
            )
            is_live = resolve_live_status(station_data, live_status)

            print(f"[{crew_name}/{user_id}] 멤버 조회 완료")

            return {
                "crew_name": crew_name,
                "user_id": station_data.get("user_id") or user_id,
                "nickname": station_data.get("nickname"),
                "profile_image_url": station_data.get("profile_image_url"),
                "broadcast_start": (
                    station_data.get("broadcast_start")
                    if is_live
                    else None
                ),
                "is_live": is_live,
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
    """data 폴더에서 가장 최근의 정상 백업 JSON 파일을 찾는다."""

    files = [
        file
        for file in OUTPUT_DIR.glob("naksoo_*.json")
        if is_successful_backup_file(file)
    ]

    if not files:
        return None

    return max(files, key=lambda file: file.stat().st_mtime)


def is_successful_backup_file(file):
    """백업 파일에 실패한 멤버가 없는지 확인한다."""

    try:
        with open(file, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"백업 파일 읽기 실패: {file}", e)
        return False

    items = data.get("items")

    if not isinstance(items, list):
        return False

    return all(item.get("success") for item in items)


# =========================
# 실패 시 최신 백업 복구
# =========================

def restore_latest_backup():
    """패치 실패 시 최신 정상 백업 파일을 result.json으로 복사한다."""

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
# 저장 전 멤버 누락 검증
# =========================

def validate_all_members_in_items(members, items):
    """구글시트 멤버가 결과 JSON에 모두 포함되어 있는지 확인한다."""

    sheet_members = Counter(
        (member["crew_name"], member["user_id"])
        for member in members
    )
    result_members = Counter(
        (item["crew_name"], item["user_id"])
        for item in items
    )

    missing_members = sheet_members - result_members
    extra_members = result_members - sheet_members

    if not missing_members and not extra_members:
        return

    errors = []

    if missing_members:
        missing_text = ", ".join(
            f"{crew_name}/{user_id}"
            for crew_name, user_id in missing_members.elements()
        )
        errors.append(f"누락 멤버: {missing_text}")

    if extra_members:
        extra_text = ", ".join(
            f"{crew_name}/{user_id}"
            for crew_name, user_id in extra_members.elements()
        )
        errors.append(f"추가 멤버: {extra_text}")

    raise RuntimeError("결과 JSON 멤버 검증 실패 - " + " / ".join(errors))


# =========================
# 백업이 하나도 없을 때 최소 result.json 생성
# =========================

def create_empty_result_json(now, error_message):
    """첫 실행부터 실패해서 백업 파일도 없을 때 최소 result.json을 생성한다."""

    current_period = {
        "year": now.year,
        "month": now.month,
    }
    previous_period = (
        {
            "year": now.year - 1,
            "month": 12,
        }
        if now.month == 1
        else {
            "year": now.year,
            "month": now.month - 1,
        }
    )

    fallback = {
        "project": "naksoo",
        "created_at": now.isoformat(),
        "created_date": now.strftime("%Y-%m-%d"),
        "created_time": now.strftime("%H:%M:%S"),
        "timezone": "Asia/Seoul",
        "error": error_message,
        "current_period": current_period,
        "previous_period": previous_period,
        "count": 0,
        "items": [],
    }

    result_path = OUTPUT_DIR / "result.json"

    with open(result_path, "w", encoding="utf-8") as f:
        json.dump(fallback, f, ensure_ascii=False, indent=2)

    print(f"빈 result.json 생성 완료: {result_path}")


def keep_existing_result_json():
    """수집 실패 시 기존 result.json이 있으면 빈 파일로 덮어쓰지 않는다."""

    result_path = OUTPUT_DIR / "result.json"

    if not result_path.exists():
        return False

    print(f"기존 result.json 유지: {result_path}")

    return True


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

        print_crawl_targets(members)

        # 동시에 너무 많은 요청을 보내지 않도록 제한
        semaphore = asyncio.Semaphore(2)
        fan_profile_cache = {}
        fan_profile_lock = asyncio.Lock()
        fan_profile_semaphore = asyncio.Semaphore(10)

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
                    fan_profile_lock,
                    fan_profile_semaphore,
                )
                for member in members
            ]

            items = await asyncio.gather(*tasks)

        # 실패한 멤버가 있어도 성공한 데이터는 저장한다.
        # 실패 항목은 success=false로 남기고, 프론트엔드는 성공 항목만 렌더링한다.
        failed_items = [item for item in items if not item["success"]]

        if failed_items and len(failed_items) == len(items):
            failed_members = ", ".join(
                f"{item['crew_name']}/{item['user_id']}: {item.get('error')}"
                for item in failed_items
            )
            raise RuntimeError(
                f"전체 멤버 조회 실패 {len(failed_items)}명: {failed_members}"
            )

        if failed_items:
            failed_members = ", ".join(
                f"{item['crew_name']}/{item['user_id']}: {item.get('error')}"
                for item in failed_items
            )
            print(f"일부 멤버 조회 실패 {len(failed_items)}명: {failed_members}")

        validate_all_members_in_items(members, items)

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

        if not restored and not keep_existing_result_json():
            create_empty_result_json(now, str(e))


# =========================
# 프로그램 시작점
# =========================

if __name__ == "__main__":
    asyncio.run(main())
