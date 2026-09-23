"""Build the compact dashboard payload in the collector, not per web request."""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta
from typing import Any
from live_totals import KST


def _number(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _profile(user_id: str, value: Any) -> str:
    value = str(value or "")
    if value:
        return f"https:{value}" if value.startswith("//") else value
    return f"https://stimg.sooplive.com/LOGO/{user_id[:2]}/{user_id}/m/{user_id}.webp"


def _daily(period: dict[str, Any], day: int) -> int:
    for value in period.get("daily_balloons") or []:
        if _number(value.get("day")) == day:
            return _number(value.get("balloons"))
    return 0


def _top_fans(period: dict[str, Any]) -> list[dict[str, Any]]:
    fans = sorted(period.get("fans") or [], key=lambda x: _number(x.get("balloons")), reverse=True)[:10]
    return [{"rank": index + 1, "user_id": str(fan.get("user_id") or ""), "nickname": str(fan.get("nickname") or ""), "balloons": _number(fan.get("balloons"))} for index, fan in enumerate(fans)]


def _crew_groups(items: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    spellings: dict[str, list[str]] = defaultdict(list)
    valid = []
    for item in items:
        if not item.get("success") or not item.get("crew_name") or not item.get("user_id"):
            continue
        name = str(item["crew_name"]).strip()
        if not name:
            continue
        key = "fa" if name.upper() == "FA" else name.lower()
        spellings[key].append("FA" if key == "fa" else name)
        valid.append(item)
    canonical = {
        key: Counter(values).most_common(1)[0][0]
        for key, values in spellings.items()
    }
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in valid:
        raw = str(item["crew_name"]).strip()
        key = "fa" if raw.upper() == "FA" else raw.lower()
        name = canonical[key]
        grouped[name].append({**item, "crew_name": name})
    return grouped


def _is_leave(item: dict[str, Any]) -> bool:
    return bool(item.get("is_on_leave")) or str(item.get("note") or "").strip().lower() == "휴직"


def _member_row(
    item: dict[str, Any],
    rank: int,
    now: datetime,
    current_year: int,
    current_month: int,
    on_leave: bool,
) -> dict[str, Any]:
    cur, prev = item.get("current_month") or {}, item.get("previous_month") or {}
    current_total, previous_total = _number(cur.get("total_balloons")), _number(prev.get("total_balloons"))
    is_current_calendar_month = (current_year, current_month) == (now.year, now.month)
    today = _daily(cur, now.day) if not on_leave and is_current_calendar_month else 0
    yesterday = (now - timedelta(days=1)).date()
    yesterday_total = 0
    if not on_leave:
        if (current_year, current_month) == (yesterday.year, yesterday.month):
            yesterday_total = _daily(cur, yesterday.day)
        else:
            previous_period = item.get("previous_month") or {}
            if (
                _number(previous_period.get("year")) == yesterday.year
                and _number(previous_period.get("month")) == yesterday.month
            ):
                yesterday_total = _daily(previous_period, yesterday.day)
    if not on_leave and is_current_calendar_month:
        reporting_date = now.date().isoformat()
        for month in (cur, prev):
            realtime = month.get("realtime_totals") or {}
            if realtime.get("date") == reporting_date and realtime.get("today") is not None:
                today = _number(realtime["today"])
    return {
        "rank": rank,
        "user_id": str(item["user_id"]),
        "nickname": str(item.get("nickname") or item["user_id"]),
        "profile_image_url": _profile(str(item["user_id"]), item.get("profile_image_url")),
        "broadcast_start": None if on_leave else item.get("broadcast_start"),
        "is_live": False if on_leave else bool(item.get("is_live")),
        "broadcast_no": None if on_leave else item.get("broadcast_no"),
        "broadcast_title": None if on_leave else item.get("broadcast_title"),
        "viewer_count": None if on_leave else item.get("viewer_count"),
        "current_balloons": current_total,
        "previous_balloons": previous_total,
        "change_balloons": current_total - previous_total,
        "change_rate": round(((current_total - previous_total) / previous_total * 100) if previous_total else (100 if current_total else 0), 1),
        "display_day_balloons": today,
        # The browser only needs yesterday's scalar on first paint. Sending
        # two complete daily arrays for every streamer bloated the RSC payload.
        "yesterday_balloons": yesterday_total,
        "monthly_fans": [],
        "monthly_top_fans": [] if on_leave else _top_fans(cur),
        "is_on_leave": on_leave,
    }


def _patrons(items: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    fans: dict[str, dict[str, Any]] = {}
    for item in items:
        for fan in (item.get("current_month") or {}).get("fans") or []:
            key = str(fan.get("user_id") or fan.get("nickname") or "")
            if not key:
                continue
            entry = fans.setdefault(key, {"user_id": str(fan.get("user_id") or ""), "nickname": str(fan.get("nickname") or key), "profile_image_url": fan.get("profile_image_url"), "total_balloons": 0, "targets": defaultdict(int)})
            entry["total_balloons"] += _number(fan.get("balloons"))
            entry["targets"][str(item.get("nickname") or "")] += _number(fan.get("balloons"))
    output = []
    for fan in fans.values():
        targets = sorted(fan["targets"].items(), key=lambda x: x[1], reverse=True)
        top_name, top_value = targets[0] if targets else ("", 0)
        output.append({"user_id": fan["user_id"], "nickname": fan["nickname"], "profile_image_url": _profile(fan["user_id"], fan["profile_image_url"]), "total_balloons": fan["total_balloons"], "target_count": len(targets), "max_target_nickname": top_name, "max_target_balloons": top_value, "max_target_rate": round((top_value / fan["total_balloons"] * 100) if fan["total_balloons"] else 0, 1), "all_targets": [{"nickname": name, "balloons": value} for name, value in targets]})
    output.sort(key=lambda x: x["total_balloons"], reverse=True)
    return [{**fan, "rank": index + 1} for index, fan in enumerate(output[:limit])]


def build_dashboard(result: dict[str, Any]) -> dict[str, Any]:
    """Return the exact top-level shape consumed by CrewDashboard."""
    now = datetime.now(KST)
    current = result.get("current_period") or {}
    previous = result.get("previous_period") or {}
    current_year, current_month = _number(current.get("year")), _number(current.get("month"))
    grouped = _crew_groups(result.get("items") or [])

    crews = []
    for crew_name, items in grouped.items():
        active = [item for item in items if not _is_leave(item)]
        leaves = [item for item in items if _is_leave(item)]
        active.sort(key=lambda x: _number((x.get("current_month") or {}).get("total_balloons")), reverse=True)
        leaves.sort(key=lambda x: str(x.get("nickname") or ""))
        members = [
            _member_row(item, rank, now, current_year, current_month, False)
            for rank, item in enumerate(active, 1)
        ]
        members.extend(
            _member_row(item, 0, now, current_year, current_month, True)
            for item in leaves
        )
        total = sum(member["current_balloons"] for member in members if not member["is_on_leave"])
        average = round(total / len(active)) if active else 0
        kings = _patrons(active, 15)
        gods = [fan for fan in kings if fan["target_count"] >= 3 and fan["max_target_rate"] < 80][:10]
        gods = [{**fan, "rank": index + 1} for index, fan in enumerate(gods)]
        crews.append({"rank": 0, "crew_name": crew_name, "member_count": len(active), "current_total_balloons": total, "average_current_balloons": average, "members": members, "naksoo_gods": gods, "crew_kings": kings})
    normal = sorted([crew for crew in crews if crew["crew_name"].strip().upper() != "FA"], key=lambda x: x["average_current_balloons"], reverse=True)
    for rank, crew in enumerate(normal, 1): crew["rank"] = rank
    fa = next((crew for crew in crews if crew["crew_name"].strip().upper() == "FA"), None)
    return {"created_date": result.get("created_date", now.strftime("%Y-%m-%d")), "created_time": result.get("created_time", now.strftime("%H:%M:%S")), "current_period": current, "previous_period": previous, "crews": normal, "fa_crew": fa}
