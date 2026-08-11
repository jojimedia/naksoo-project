# main.py

import asyncio
import csv
import json
import os
import re
from collections import Counter
from html import unescape
from io import StringIO
from datetime import datetime, timedelta
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

# 타임스탬프 스냅샷 백업 (보관 기간·개수 초과 시 파일 삭제)
BACKUP_DIR = Path(__file__).resolve().parent / "backups"
BACKUP_RETENTION_DAYS = max(
    1,
    int(os.environ.get("NAKSOO_BACKUP_RETENTION_DAYS", "3")),
)
BACKUP_MAX_COUNT = max(
    1,
    int(os.environ.get("NAKSOO_BACKUP_MAX_COUNT", "100")),
)

# GitHub result.json (패치 실패 시 추가 복구 소스)
GITHUB_REPO = "jojimedia/naksoo-project"
GITHUB_RESULT_PATH = "backend/data/result.json"
GITHUB_DATA_REF = os.environ.get("GITHUB_DATA_REF", "main")

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

POONGGO_HEADERS = {
    **HEADERS,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": "https://poonggo.com/",
    "Origin": "https://poonggo.com",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}

ENABLE_POONGGO_FALLBACK = (
    os.environ.get("NAKSOO_ENABLE_POONGGO_FALLBACK", "0") == "1"
)

# =========================
# 현재월 / 이전달 계산
# =========================

def get_previous_period(year, month):
    """특정 월의 바로 이전 달을 계산한다."""

    if month == 1:
        return year - 1, 12

    return year, month - 1


def get_calendar_period(now):
    """오늘 날짜 기준 달력상 현재월과 이전달을 계산한다."""

    current_year = now.year
    current_month = now.month
    previous_year, previous_month = get_previous_period(current_year, current_month)

    return {
        "current": {
            "year": current_year,
            "month": current_month,
        },
        "previous": {
            "year": previous_year,
            "month": previous_month,
        },
    }


def is_month_data_available(balloon_data):
    """
    풍투 API에 해당 월 데이터가 올라왔는지 확인한다.
    새 달 초반에는 d 배열 자체가 비어 있는 경우가 많다.
    """

    if not isinstance(balloon_data, dict):
        return False

    daily = balloon_data.get("d")

    return isinstance(daily, list) and len(daily) > 0


def is_poong_not_found_response(balloon_data):
    """풍투가 아직 해당 월 데이터를 만들지 않았을 때 내려주는 응답인지 확인한다."""

    if not isinstance(balloon_data, dict):
        return False

    return balloon_data.get("error") == "not found"


def is_suspicious_month_data(month_data, calendar_year, calendar_month, now):
    """
    풍투가 비정상 데이터를 내려줄 때 감지한다.
    예: 6월 1일인데 6월 daily 데이터가 오늘 이후 날짜까지 채워져 있음
    """

    if month_data.get("year") != calendar_year:
        return False

    if month_data.get("month") != calendar_month:
        return False

    daily = month_data.get("daily_balloons") or []
    max_day = max((entry.get("day") or 0 for entry in daily), default=0)

    return max_day > now.day


# =========================
# 구글시트 CSV 읽기
# =========================

async def fetch_google_sheet_members():
    """구글시트 CSV에서 crew_name, user_id, note 목록을 가져온다."""

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
        note = row.get("note", "").strip()
        nickname = row.get("nickname", "").strip()

        # 빈 행은 무시
        if not crew_name or not user_id:
            continue

        members.append({
            "crew_name": crew_name,
            "user_id": user_id,
            "nickname": nickname,
            "note": note,
            "is_on_leave": note.lower() == "휴직",
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

    응답 필드 요약 (자세한 매핑: docs/bj-detail-get.md):
    - b: 월 누적 별풍선 → total_balloons
    - d[]: 일별 (d=day, b=balloons) → daily_balloons
    - f[]: 후원자 (i, n, b, c) → fans (상위 50)
    - error: "not found" 시 chart/get fallback
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


async def fetch_month_ranking(client, year, month):
    """풍투 숲 전체 월간 랭킹(chart/get)을 가져온다."""

    url = (
        "https://static.poong.today/chart/get"
        f"?ctype=month&ks=false&year={year}&month={month}&day=undefined"
    )

    res = await client.get(url, headers=POONG_HEADERS)

    if res.status_code != 200:
        body_preview = res.text[:200].replace("\n", " ")
        raise RuntimeError(
            f"chart/get 실패: {year}-{month} "
            f"{res.status_code} body={body_preview!r}"
        )

    try:
        data = res.json()
    except ValueError as e:
        body_preview = res.text[:200].replace("\n", " ")
        raise RuntimeError(
            f"chart/get JSON 파싱 실패: {year}-{month} "
            f"body={body_preview!r}"
        ) from e

    if not isinstance(data, dict) or data.get("error"):
        return []

    ranking = data.get("b")

    if not isinstance(ranking, list):
        return []

    return ranking


async def get_month_ranking_cached(client, year, month, ranking_cache):
    """월간 랭킹을 (year, month) 단위로 한 번만 조회한다."""

    key = (year, month)

    if key not in ranking_cache:
        ranking_cache[key] = await fetch_month_ranking(client, year, month)

    return ranking_cache[key]


def find_ranking_entry(ranking, user_id):
    """월간 랭킹 배열에서 BJ user_id에 해당하는 항목을 찾는다."""

    for entry in ranking:
        if entry.get("i") == user_id:
            return entry

    return None


def build_month_data_from_chart(entry, year, month):
    """chart/get 랭킹 한 줄에서 월합만 채운 month_data를 만든다."""

    return {
        "year": year,
        "month": month,
        "total_balloons": int(entry.get("b") or 0),
        "daily_balloons": [],
        "fans": [],
        "data_source": "chart_ranking",
    }


def parse_int_text(value):
    """쉼표/기호가 섞인 텍스트에서 정수만 추출한다."""

    text = str(value or "")
    digits = re.sub(r"[^\d]", "", text)

    return int(digits) if digits else 0


def strip_html(value):
    """좁은 범위의 HTML 조각을 사람이 읽는 텍스트로 바꾼다."""

    text = re.sub(r"<[^>]+>", " ", value or "")
    text = unescape(text)

    return " ".join(text.split())


def parse_poonggo_total(html):
    """poonggo 월간/일별 페이지의 '별풍선 합계' 값을 읽는다."""

    match = re.search(
        r"<span>\s*별풍선 합계\s*</span>.*?<h3[^>]*>(.*?)</h3>",
        html,
        flags=re.DOTALL,
    )

    if not match:
        return None

    return parse_int_text(strip_html(match.group(1)))


def parse_poonggo_fan_rows(html, limit=50):
    """poonggo 팬랭킹 HTML을 기존 result.json fans 배열로 변환한다."""

    fans = []

    for chunk in re.findall(r"<li>(.*?)</li>", html, flags=re.DOTALL):
        href_match = re.search(
            r'href="https://www\.sooplive\.co\.kr/station/([^"]+)"',
            chunk,
        )

        if not href_match:
            continue

        user_id = href_match.group(1).strip()
        anchor_match = re.search(
            r"<a\b[^>]*>(.*?)</a>",
            chunk,
            flags=re.DOTALL,
        )
        anchor_text = strip_html(anchor_match.group(1)) if anchor_match else ""
        nickname = re.sub(r"^(👑|🥈|🥉|\d+)\s*", "", anchor_text).strip()

        values = [
            parse_int_text(strip_html(match))
            for match in re.findall(
                r'<div[^>]*class="[^"]*\bflx\b[^"]*\bjc\b[^"]*"[^>]*>'
                r"(.*?)</div>",
                chunk,
                flags=re.DOTALL,
            )
        ]

        if not values:
            continue

        balloons = values[0]
        count = values[1] if len(values) > 1 else 0

        fans.append({
            "user_id": user_id,
            "nickname": nickname or user_id,
            "balloons": balloons,
            "count": count,
            "avg_balloons": int(balloons / count) if count else 0,
        })

        if len(fans) >= limit:
            break

    return fans


def parse_poonggo_month_data(html, year, month):
    """poonggo station 월간 HTML을 기존 month_data 형태로 변환한다."""

    total_balloons = parse_poonggo_total(html)

    if total_balloons is None:
        raise RuntimeError("poonggo total 파싱 실패")

    return {
        "year": year,
        "month": month,
        "total_balloons": total_balloons,
        "daily_balloons": [],
        "fans": parse_poonggo_fan_rows(html),
        "data_source": "poonggo_monthly",
    }


async def fetch_poonggo_month_data(client, user_id, year, month):
    """poonggo station 월간 통계 HTML에서 월합과 팬랭킹을 가져온다."""

    url = (
        f"https://poonggo.com/station/{user_id}"
        f"?c=monthly&date={year}-{month:02d}-01&page=1&tab=1"
    )

    res = await client.get(url, headers=POONGGO_HEADERS)

    if res.status_code != 200:
        body_preview = res.text[:200].replace("\n", " ")
        raise RuntimeError(
            f"poonggo 월간 실패: {user_id} {year}-{month} "
            f"{res.status_code} body={body_preview!r}"
        )

    return parse_poonggo_month_data(res.text, year, month)


async def resolve_month_balloon_data(
    client,
    user_id,
    year,
    month,
    ranking_cache,
    crew_name="",
):
    """
    풍투(poong.today) detail/get → chart/get 을 기본으로 사용한다.
    detail 경로에는 일별(d)이 있어 오늘 별풍선도 채워진다.
    NAKSOO_ENABLE_POONGGO_FALLBACK=1이면 풍투 실패 시 poonggo 월간 HTML을 사용한다.
    """

    label = f"{crew_name}/{user_id} balloon {year}-{month}"
    balloon_data = None

    try:
        balloon_data = await retry(
            lambda: fetch_balloon(client, user_id, year, month),
            retries=8,
            delay=2,
            label=label,
        )
    except Exception as e:
        print(f"[{crew_name}/{user_id}] detail/get 실패 {year}-{month}: {e}")

    if (
        balloon_data is not None
        and not is_poong_not_found_response(balloon_data)
        and is_month_data_available(balloon_data)
    ):
        month_data = build_month_data(balloon_data, year, month)
        month_data["data_source"] = "detail"
        print(
            f"[{crew_name}/{user_id}] detail/get 성공 {year}-{month} "
            f"total={month_data.get('total_balloons')} "
            f"daily={len(month_data.get('daily_balloons') or [])}"
        )
        return month_data

    try:
        ranking = await get_month_ranking_cached(
            client,
            year,
            month,
            ranking_cache,
        )
    except Exception as e:
        print(f"[{crew_name}/{user_id}] chart/get 실패 {year}-{month}: {e}")
        ranking = None

    if ranking is not None:
        entry = find_ranking_entry(ranking, user_id)

        if entry is None:
            print(
                f"[{crew_name}/{user_id}] chart/get 미등록 {year}-{month} → 월합 0"
            )
            return {
                "year": year,
                "month": month,
                "total_balloons": 0,
                "daily_balloons": [],
                "fans": [],
                "data_source": "chart_ranking",
            }

        print(
            f"[{crew_name}/{user_id}] chart/get fallback {year}-{month} "
            f"total={entry.get('b')}"
        )
        return build_month_data_from_chart(entry, year, month)

    if not ENABLE_POONGGO_FALLBACK:
        print(
            f"[{crew_name}/{user_id}] 풍고 fallback 비활성화 "
            f"{year}-{month}"
        )
        return None

    try:
        month_data = await retry(
            lambda: fetch_poonggo_month_data(client, user_id, year, month),
            retries=3,
            delay=1,
            label=f"{crew_name}/{user_id} poonggo {year}-{month}",
        )
        print(
            f"[{crew_name}/{user_id}] poonggo 월간 성공 {year}-{month} "
            f"total={month_data.get('total_balloons')}"
        )
        return month_data
    except Exception as e:
        print(f"[{crew_name}/{user_id}] poonggo 월간 실패 {year}-{month}: {e}")
        return None


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

    for item in balloon_data.get("d") or []:
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

    for fan in (balloon_data.get("f") or [])[:limit]:
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


async def fetch_current_month_data(
    client,
    user_id,
    crew_name,
    calendar_current,
    ranking_cache,
):
    """
    달력상 현재월 데이터를 조회한다.
    detail/get 실패 시 chart/get 월합을 쓰고, 둘 다 없으면 전월로 fallback한다.
    """

    current_year = calendar_current["year"]
    current_month = calendar_current["month"]

    print(
        f"[{crew_name}/{user_id}] 별풍 현재월 조회 "
        f"{current_year}-{current_month}"
    )

    current_month_data = await resolve_month_balloon_data(
        client,
        user_id,
        current_year,
        current_month,
        ranking_cache,
        crew_name,
    )

    if current_month_data is not None:
        return current_month_data, False

    print(
        f"[{crew_name}/{user_id}] 현재월 detail/chart 없음 → "
        f"{current_year}-{current_month} 월합 0"
    )

    return {
        "year": current_year,
        "month": current_month,
        "total_balloons": 0,
        "daily_balloons": [],
        "fans": [],
        "data_source": "unavailable",
    }, True


# =========================
# 멤버 1명 데이터 가져오기
# =========================

async def fetch_one_member(
    client,
    member,
    period,
    ranking_cache,
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

            current_month_data, used_month_fallback = await fetch_current_month_data(
                client,
                user_id,
                crew_name,
                period["calendar_current"],
                ranking_cache,
            )

            await asyncio.sleep(0.5)

            # 이전달 별풍 데이터 가져오기
            print(
                f"[{crew_name}/{user_id}] 별풍 이전달 조회 "
                f"{previous_year}-{previous_month}"
            )
            previous_month_data = await resolve_month_balloon_data(
                client,
                user_id,
                previous_year,
                previous_month,
                ranking_cache,
                crew_name,
            )

            if previous_month_data is None:
                previous_month_data = {
                    "year": previous_year,
                    "month": previous_month,
                    "total_balloons": 0,
                    "daily_balloons": [],
                    "fans": [],
                }

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
                "note": member.get("note", ""),
                "is_on_leave": member.get("is_on_leave", False),
                "broadcast_start": (
                    station_data.get("broadcast_start")
                    if is_live
                    else None
                ),
                "is_live": is_live,
                "is_password_broadcast": live_status["is_password"],
                "current_month_used_fallback": used_month_fallback,

                "current_month": current_month_data,

                "previous_month": previous_month_data,

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
# GitHub result.json / 백업
# =========================

def github_result_raw_url(ref=None):
    """GitHub raw URL for result.json at a ref or commit sha."""

    return (
        f"https://raw.githubusercontent.com/{GITHUB_REPO}/"
        f"{ref or GITHUB_DATA_REF}/{GITHUB_RESULT_PATH}"
    )


async def fetch_github_result_json(ref=None):
    """GitHub에 올라간 result.json을 가져온다."""

    url = github_result_raw_url(ref)

    async with httpx.AsyncClient(
        follow_redirects=True,
        timeout=30,
        headers=HEADERS,
    ) as client:
        res = await client.get(url)
        res.raise_for_status()
        return res.json()


async def fetch_github_result_commits(limit=20):
    """result.json 변경 GitHub 커밋 목록을 최신순으로 가져온다."""

    url = f"https://api.github.com/repos/{GITHUB_REPO}/commits"
    params = {
        "path": GITHUB_RESULT_PATH,
        "sha": "main",
        "per_page": limit,
    }

    async with httpx.AsyncClient(
        follow_redirects=True,
        timeout=30,
        headers=HEADERS,
    ) as client:
        res = await client.get(url, params=params)
        res.raise_for_status()
        return res.json()


def is_successful_backup_data(data):
    """백업 JSON에 실패한 멤버가 없는지 확인한다."""

    items = data.get("items")

    if not isinstance(items, list):
        return False

    return all(item.get("success") for item in items)


def items_map_from_result(data):
    """result.json items를 (crew_name, user_id) 맵으로 변환한다."""

    items = data.get("items")

    if not isinstance(items, list):
        return {}

    return {
        (item.get("crew_name"), item.get("user_id")): item
        for item in items
        if item.get("crew_name") and item.get("user_id")
    }


async def load_previous_result_items():
    """GitHub main의 result.json에서 직전 데이터를 읽는다."""

    try:
        data = await fetch_github_result_json()
    except Exception as e:
        print(f"GitHub result.json 읽기 실패: {e}")
        return {}

    return items_map_from_result(data)


async def find_github_backup_data(skip=1, limit=20):
    """
    GitHub result.json 커밋 이력에서 정상 백업을 찾는다.
    skip=0 최신, skip=1 바로 이전 커밋 ...
    """

    commits = await fetch_github_result_commits(limit=skip + 10)

    for commit in commits[skip:]:
        sha = commit["sha"]

        try:
            data = await fetch_github_result_json(sha)
        except Exception as e:
            print(f"GitHub 백업 읽기 실패: {sha[:8]}", e)
            continue

        if is_successful_backup_data(data):
            return data, sha

    return None, None


def write_result_json(data):
    """패치/복구 결과를 result.json으로 저장한다."""

    result_path = OUTPUT_DIR / "result.json"

    with open(result_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"result.json 저장 완료: {result_path}")


def list_local_backup_paths():
    """백업 스냅샷 경로를 최신순으로 반환한다."""

    if not BACKUP_DIR.exists():
        return []

    return sorted(
        BACKUP_DIR.glob("*.json"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )


def load_local_backup_data(skip=0):
    """
    로컬 백업 스냅샷을 읽는다.
    skip=0 최신, skip=1 그 이전 ...
  """

    paths = list_local_backup_paths()

    if len(paths) <= skip:
        return None, None

    path = paths[skip]

    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"로컬 백업 읽기 실패: {path.name}", e)
        return None, None

    if not is_successful_backup_data(data):
        return None, None

    return data, path


def save_backup_snapshot(data, now):
    """패치 성공 시 타임스탬프 백업 파일을 만든다."""

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    backup_path = BACKUP_DIR / f"{now.strftime('%Y-%m-%d_%H%M%S')}.json"

    with open(backup_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"백업 스냅샷 저장: {backup_path.name}")


def parse_backup_timestamp(backup_path):
    """백업 파일명(YYYY-MM-DD_HHMMSS.json)에서 시각을 파싱한다."""

    stem = backup_path.stem

    try:
        parsed = datetime.strptime(stem, "%Y-%m-%d_%H%M%S")
    except ValueError:
        return None

    return parsed.replace(tzinfo=TIMEZONE)


def backup_file_timestamp(backup_path, now):
    """파일명 시각을 우선하고, 없으면 수정 시각을 쓴다."""

    parsed = parse_backup_timestamp(backup_path)

    if parsed is not None:
        return parsed

    return datetime.fromtimestamp(backup_path.stat().st_mtime, tz=TIMEZONE)


def delete_backup_file(backup_path, reason):
    """백업 스냅샷 파일을 디스크에서 삭제한다."""

    try:
        backup_path.unlink()
    except OSError as e:
        print(f"백업 파일 삭제 실패: {backup_path.name} ({e})")
        return False

    print(f"백업 파일 삭제 ({reason}): {backup_path.name}")
    return True


def prune_invalid_backup_files():
    """손상되었거나 실패 데이터인 백업 파일을 삭제한다."""

    removed = 0

    for backup_path in list(BACKUP_DIR.glob("*.json")):
        try:
            with open(backup_path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            if delete_backup_file(backup_path, "읽기 실패"):
                removed += 1
            continue

        if not is_successful_backup_data(data):
            if delete_backup_file(backup_path, "유효하지 않은 데이터"):
                removed += 1

    return removed


def prune_old_backups(now):
    """보관 기간(N일)을 넘긴 백업 스냅샷 파일을 삭제한다."""

    if not BACKUP_DIR.exists():
        return 0

    cutoff = now - timedelta(days=BACKUP_RETENTION_DAYS)
    removed = 0

    for backup_path in list_local_backup_paths()[::-1]:
        if backup_file_timestamp(backup_path, now) >= cutoff:
            continue

        if delete_backup_file(backup_path, f"보관 {BACKUP_RETENTION_DAYS}일 초과"):
            removed += 1

    return removed


def prune_excess_backup_count():
    """최대 보관 개수를 넘는 오래된 백업 파일을 삭제한다."""

    paths = list_local_backup_paths()
    removed = 0

    for backup_path in paths[BACKUP_MAX_COUNT:]:
        if delete_backup_file(backup_path, f"개수 상한 {BACKUP_MAX_COUNT}개 초과"):
            removed += 1

    return removed


def cleanup_backup_files(now):
    """백업 폴더 정리: 손상 파일·보관 일수·개수 상한 기준으로 삭제."""

    if not BACKUP_DIR.exists():
        return {
            "invalid": 0,
            "expired": 0,
            "excess": 0,
        }

    invalid = prune_invalid_backup_files()
    expired = prune_old_backups(now)
    excess = prune_excess_backup_count()
    total = invalid + expired + excess

    if total:
        print(
            f"백업 정리 완료: 삭제 {total}개 "
            f"(손상 {invalid}, 기간 {expired}, 개수 {excess})"
        )

    return {
        "invalid": invalid,
        "expired": expired,
        "excess": excess,
    }


# =========================
# 실패 시 백업 복구
# =========================

async def restore_latest_backup():
    """패치 실패 시 최신 로컬 스냅샷 또는 GitHub 직전 커밋으로 복구한다."""

    data, backup_path = load_local_backup_data(skip=0)

    if data is not None:
        write_result_json(data)
        print(f"로컬 백업 복구 완료: {backup_path.name}")
        return True

    data, sha = await find_github_backup_data(skip=1)

    if data is None:
        print("복구 가능한 백업 없음")
        return False

    write_result_json(data)
    print(f"GitHub 백업 복구 완료: {sha[:8]}")

    return True


# =========================
# 결과 JSON 저장
# =========================

def save_result_json(output, now):
    """패치 성공 시 result.json 저장 + 스냅샷 백업 + 오래된 백업 파일 삭제."""

    write_result_json(output)
    save_backup_snapshot(output, now)
    cleanup_backup_files(now)


# =========================
# 기존 result.json 멤버 데이터 읽기
# =========================

async def restore_failed_items_from_previous_result(items, period):
    """이번 수집에 실패한 멤버만 GitHub result.json의 해당 멤버 데이터로 대체한다."""

    previous_items = await load_previous_result_items()

    if not previous_items:
        return items

    calendar_period = (
        period["calendar_current"]["year"],
        period["calendar_current"]["month"],
    )
    restored_items = []

    for item in items:
        if item.get("success"):
            restored_items.append(item)
            continue

        key = (item.get("crew_name"), item.get("user_id"))
        previous_item = previous_items.get(key)

        if previous_item is None:
            restored_items.append(item)
            continue

        previous_current = previous_item.get("current_month") or {}
        backup_period = (
            previous_current.get("year"),
            previous_current.get("month"),
        )

        if backup_period != calendar_period:
            restored_items.append(item)
            continue

        restored_item = {
            **previous_item,
            "success": True,
            "is_stale": True,
            "stale_reason": item.get("error"),
            "stale_source": "github_result",
        }
        restored_items.append(restored_item)
        print(
            "GitHub result.json 데이터로 멤버 복구:",
            f"{key[0]}/{key[1]}",
            item.get("error"),
        )

    return restored_items


async def restore_suspicious_month_items_from_previous_result(items, period):
    """
    전월 fallback 또는 의심스러운 풍투 응답이
    GitHub result.json보다 작거나 비정상이면 기존 데이터를 유지한다.
    """

    previous_items = await load_previous_result_items()

    if not previous_items:
        return items

    calendar_current = period["calendar_current"]
    calendar_period = (
        calendar_current["year"],
        calendar_current["month"],
    )
    now = period["now"]
    restored_items = []

    for item in items:
        key = (item.get("crew_name"), item.get("user_id"))
        previous_item = previous_items.get(key)

        if previous_item is None:
            restored_items.append(item)
            continue

        item_current = item.get("current_month") or {}
        previous_current = previous_item.get("current_month") or {}
        item_period = (
            item_current.get("year"),
            item_current.get("month"),
        )
        backup_period = (
            previous_current.get("year"),
            previous_current.get("month"),
        )

        # GitHub에 5월이 current_month에 남은 등 달력 현재월과 맞지 않는 백업은 쓰지 않는다.
        if backup_period != calendar_period:
            restored_items.append(item)
            continue

        # 전월 fallback으로 current_month에 전월이 들어간 경우도 GitHub와 비교·복구하지 않는다.
        if item_period != calendar_period:
            restored_items.append(item)
            continue

        item_total = int(item_current.get("total_balloons") or 0)
        previous_total = int(previous_current.get("total_balloons") or 0)
        used_fallback = item.get("current_month_used_fallback", False)

        suspicious = is_suspicious_month_data(
            item_current,
            calendar_current["year"],
            calendar_current["month"],
            now,
        )

        is_same_period = item_period == backup_period
        regressed = is_same_period and previous_total > item_total

        # 의도적으로 선택한 월합 소스는 GitHub 회귀 보정으로 덮지 않는다.
        # poonggo 전환 후에는 이전 풍투 값보다 작아도 최신 기준값으로 본다.
        if item_current.get("data_source") in (
            "chart_ranking",
            "poonggo_monthly",
        ) and regressed:
            restored_items.append(item)
            continue

        should_restore = (
            suspicious
            or regressed
            or (used_fallback and item_total == 0)
        )

        if not should_restore:
            restored_items.append(item)
            continue

        if suspicious:
            reason = "poong current month suspicious"
        elif regressed:
            reason = f"poong month regressed {previous_total}->{item_total}"
        else:
            reason = "poong fallback empty"

        restored_item = {
            **previous_item,
            "broadcast_start": item.get("broadcast_start"),
            "is_live": item.get("is_live", False),
            "is_password_broadcast": item.get(
                "is_password_broadcast",
                False,
            ),
            "success": True,
            "is_stale": True,
            "stale_reason": reason,
            "stale_source": "github_result",
        }
        restored_items.append(restored_item)
        print(
            "풍투 데이터 이상으로 GitHub 데이터 유지:",
            f"{key[0]}/{key[1]}",
            reason,
        )

    return restored_items


# =========================
# 저장 전 멤버 누락 검증
# =========================

def build_on_leave_item(member, period):
    """휴직 멤버용 result.json 항목을 만든다."""

    current_year = period["current"]["year"]
    current_month = period["current"]["month"]
    previous_year = period["previous"]["year"]
    previous_month = period["previous"]["month"]

    empty_month = lambda year, month: {
        "year": year,
        "month": month,
        "total_balloons": 0,
        "daily_balloons": [],
        "fans": [],
    }

    return {
        "crew_name": member["crew_name"],
        "user_id": member["user_id"],
        "nickname": member.get("nickname") or member["user_id"],
        "profile_image_url": None,
        "broadcast_start": None,
        "is_live": False,
        "is_password_broadcast": False,
        "note": member.get("note", "휴직"),
        "is_on_leave": True,
        "current_month_used_fallback": False,
        "current_month": empty_month(current_year, current_month),
        "previous_month": empty_month(previous_year, previous_month),
        "success": True,
    }


def apply_member_sheet_metadata(items, members, period):
    """시트의 note/휴직 정보를 result.json에 반영한다."""

    member_map = {
        (member["crew_name"], member["user_id"]): member
        for member in members
    }
    item_keys = {(item["crew_name"], item["user_id"]) for item in items}

    for item in items:
        member = member_map.get((item["crew_name"], item["user_id"]))
        if not member:
            continue

        item["note"] = member.get("note", "")
        item["is_on_leave"] = member.get("is_on_leave", False)

    for member in members:
        if not member.get("is_on_leave"):
            continue

        key = (member["crew_name"], member["user_id"])
        if key in item_keys:
            continue

        items.append(build_on_leave_item(member, period))

    return items


def validate_all_members_in_items(members, items):
    """구글시트 활성 멤버가 결과 JSON에 모두 포함되어 있는지 확인한다."""

    active_members = [
        member for member in members if not member.get("is_on_leave")
    ]

    sheet_members = Counter(
        (member["crew_name"], member["user_id"])
        for member in active_members
    )
    result_members = Counter(
        (item["crew_name"], item["user_id"])
        for item in items
        if not item.get("is_on_leave")
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
    3. 풍고 기준으로 멤버별 별풍선 정보 가져오기
    4. JSON 구조로 정리
    5. 성공하면 백업 JSON + result.json 저장
    6. 전체 실패하면 최신 백업을 result.json으로 복구
    """

    now = datetime.now(TIMEZONE)

    OUTPUT_DIR.mkdir(exist_ok=True)
    cleanup_backup_files(now)

    try:
        members = await fetch_google_sheet_members()
        print(f"시트 멤버 수: {len(members)}명")

        if not members:
            raise RuntimeError("구글시트에서 멤버를 가져오지 못함")

        active_members = [
            member for member in members if not member.get("is_on_leave")
        ]
        on_leave_count = len(members) - len(active_members)

        if on_leave_count:
            print(f"휴직 멤버 {on_leave_count}명은 크롤 대상에서 제외")

        print_crawl_targets(active_members)

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
            calendar = get_calendar_period(now)
            period = {
                "now": now,
                **calendar,
                "calendar_current": calendar["current"],
            }
            ranking_cache = {}

            for year, month in (
                (calendar["current"]["year"], calendar["current"]["month"]),
                (calendar["previous"]["year"], calendar["previous"]["month"]),
            ):
                try:
                    await get_month_ranking_cached(
                        client,
                        year,
                        month,
                        ranking_cache,
                    )
                    print(f"풍투 월간 랭킹 캐시 로드: {year}-{month}")
                except Exception as e:
                    print(f"풍투 월간 랭킹 캐시 로드 실패: {year}-{month}", e)

            tasks = [
                fetch_one_member(
                    client,
                    member,
                    period,
                    ranking_cache,
                    semaphore,
                    fan_profile_cache,
                    fan_profile_lock,
                    fan_profile_semaphore,
                )
                for member in active_members
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
            items = await restore_failed_items_from_previous_result(items, period)

        items = await restore_suspicious_month_items_from_previous_result(
            items,
            period,
        )

        items = apply_member_sheet_metadata(items, members, period)

        validate_all_members_in_items(members, items)

        used_month_fallback = any(
            item.get("current_month_used_fallback") for item in items
        )

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
            "calendar_current_period": period["calendar_current"],
            "used_month_fallback": used_month_fallback,

            "count": len(items),
            "items": items,
        }

        save_result_json(output, now)

    except Exception as e:
        print("패치 실패")
        print("에러:", e)
        print("최신 백업으로 result.json 복구 시도")

        restored = await restore_latest_backup()

        if not restored and not keep_existing_result_json():
            create_empty_result_json(now, str(e))


# =========================
# 프로그램 시작점
# =========================

if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "--prune-backups":
        cleanup_backup_files(datetime.now(TIMEZONE))
    else:
        asyncio.run(main())
