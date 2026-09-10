"""Shared Poong chart snapshots; never request charts once per member."""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from main import POONG_HEADERS, source_error

KST = ZoneInfo("Asia/Seoul")
POLL_SECONDS = 45


def chart_date(now):
    # Poong's public frontend defines its reporting day as local time - 8h.
    return (now.astimezone(KST) - timedelta(hours=8)).date()


async def fetch_totals(client, now):
    day = chart_date(now)
    results = []
    # Two shared requests, no retries/burst fan-out. Retry on the next tick.
    for kind in ("day", "month"):
        response = await client.get(
            "https://static.poong.today/chart/get",
            params={"ctype": kind, "ks": "false", "year": day.year,
                    "month": day.month, "day": day.day if kind == "day" else "undefined",
                    "cache_bust": int(now.timestamp()) // POLL_SECONDS},
            headers=POONG_HEADERS,
        )
        if response.status_code != 200:
            raise source_error(f"live chart {kind}: HTTP {response.status_code}", response)
        data = response.json()
        rows = data.get("b") if kind == "month" and isinstance(data, dict) else data
        if not isinstance(rows, list) or not rows:
            raise ValueError(f"live chart {kind}: missing ranking; retaining previous values")
        values = {}
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("i"), str):
                continue
            count = row.get("b")
            if isinstance(count, int) and not isinstance(count, bool) and count >= 0:
                values[row["i"]] = count
        if not values:
            raise ValueError(f"live chart {kind}: no valid totals")
        results.append(values)
    daily, monthly = results
    return {uid: {"date": day.isoformat(), "year": day.year, "month": day.month,
                  "total": total, "today": daily.get(uid),
                  "observed_at": datetime.now(KST).isoformat()}
            for uid, total in monthly.items()}


def apply_totals(result, snapshots):
    changed = 0
    for item in result.get("items") or []:
        snapshot = snapshots.get(item.get("user_id"))
        if not snapshot:
            continue
        # At the month boundary Poong still reports the previous month until
        # 08:00. Never apply that monthly total to the new calendar month.
        for key in ("current_month", "previous_month"):
            month = item.get(key) or {}
            if (month.get("year"), month.get("month")) != (snapshot["year"], snapshot["month"]):
                continue
            previous = month.get("realtime_totals") or {}
            if previous.get("observed_at", "") > snapshot["observed_at"]:
                continue
            total = max(int(month.get("total_balloons") or 0), snapshot["total"])
            today = snapshot["today"]
            if today is not None and previous.get("date") == snapshot["date"] and previous.get("today") is not None:
                today = max(today, previous["today"])
            if total != month.get("total_balloons") or previous.get("today") != today:
                changed += 1
            month["total_balloons"] = total
            month["realtime_totals"] = dict(snapshot, total=total, today=today)
            if today is not None:
                day_number = int(snapshot["date"][-2:])
                daily = [dict(row) for row in month.get("daily_balloons") or []
                         if row.get("day") != day_number]
                daily.append({"day": day_number, "balloons": today})
                month["daily_balloons"] = sorted(daily, key=lambda row: row["day"])
    return changed


def saved_totals(result):
    snapshots = {}
    for item in result.get("items") or []:
        for key in ("previous_month", "current_month"):
            value = (item.get(key) or {}).get("realtime_totals")
            if value:
                snapshots[item["user_id"]] = value
    return snapshots
