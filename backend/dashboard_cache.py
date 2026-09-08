"""Build the compact dashboard payload in the collector, not per web request."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any


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
    now = datetime.now().astimezone()
    current = result.get("current_period") or {}
    previous = result.get("previous_period") or {}
    current_year, current_month = _number(current.get("year")), _number(current.get("month"))
    display_day = now.day
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in result.get("items") or []:
        if not item.get("success") or not item.get("crew_name") or not item.get("user_id"):
            continue
        grouped[str(item["crew_name"])].append(item)

    crews = []
    for crew_name, items in grouped.items():
        active = [item for item in items if not item.get("is_on_leave") and str(item.get("note") or "").lower() != "휴직"]
        active.sort(key=lambda x: _number((x.get("current_month") or {}).get("total_balloons")), reverse=True)
        members = []
        for rank, item in enumerate(active, 1):
            cur, prev = item.get("current_month") or {}, item.get("previous_month") or {}
            current_total, previous_total = _number(cur.get("total_balloons")), _number(prev.get("total_balloons"))
            today = _daily(cur, display_day)
            if today <= 0:
                yesterday = now - timedelta(days=1)
                source = cur if (yesterday.year, yesterday.month) == (current_year, current_month) else prev
                today = _daily(source, yesterday.day)
            members.append({"rank": rank, "user_id": str(item["user_id"]), "nickname": str(item.get("nickname") or item["user_id"]), "profile_image_url": _profile(str(item["user_id"]), item.get("profile_image_url")), "broadcast_start": item.get("broadcast_start"), "is_live": bool(item.get("is_live")), "broadcast_no": item.get("broadcast_no"), "broadcast_title": item.get("broadcast_title"), "viewer_count": item.get("viewer_count"), "current_balloons": current_total, "previous_balloons": previous_total, "change_balloons": current_total - previous_total, "change_rate": round(((current_total - previous_total) / previous_total * 100) if previous_total else (100 if current_total else 0), 1), "display_day_balloons": today, "current_daily_balloons": cur.get("daily_balloons") or [], "previous_daily_balloons": prev.get("daily_balloons") or [], "monthly_fans": [], "monthly_top_fans": _top_fans(cur), "is_on_leave": False})
        total = sum(member["current_balloons"] for member in members)
        average = round(total / len(members)) if members else 0
        kings = _patrons(active, 15)
        gods = [fan for fan in kings if fan["target_count"] >= 3 and fan["max_target_rate"] < 80][:10]
        gods = [{**fan, "rank": index + 1} for index, fan in enumerate(gods)]
        crews.append({"rank": 0, "crew_name": crew_name, "member_count": len(members), "current_total_balloons": total, "average_current_balloons": average, "members": members, "naksoo_gods": gods, "crew_kings": kings})
    normal = sorted([crew for crew in crews if crew["crew_name"].strip().upper() != "FA"], key=lambda x: x["average_current_balloons"], reverse=True)
    for rank, crew in enumerate(normal, 1): crew["rank"] = rank
    fa = next((crew for crew in crews if crew["crew_name"].strip().upper() == "FA"), None)
    return {"created_date": result.get("created_date", now.strftime("%Y-%m-%d")), "created_time": result.get("created_time", now.strftime("%H:%M:%S")), "current_period": current, "previous_period": previous, "crews": normal, "fa_crew": fa}
