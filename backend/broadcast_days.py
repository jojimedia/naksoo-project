"""Daily rankings use KST broadcast start dates, never gift/calendar dates.

Input rows are distinct broadcast snapshots. Repeated observations replace a
broadcast; distinct broadcasts starting on the same date are added together.
"""


def sum_fans(groups):
    merged = {}
    for fans in groups:
        for fan in fans or []:
            key = str(fan.get("user_id") or fan.get("nickname") or "").lower()
            if not key:
                continue
            entry = merged.setdefault(key, {**fan, "balloons": 0})
            entry["balloons"] += int(fan.get("balloons") or 0)
            entry["nickname"] = fan.get("nickname") or entry.get("nickname") or key
    ordered = sorted(merged.values(), key=lambda fan: fan["balloons"], reverse=True)
    return [{**fan, "rank": i + 1} for i, fan in enumerate(ordered)]


def aggregate_days(rows):
    # Callers order observations oldest -> newest, or overlay hot rows last.
    unique = {}
    for i, row in enumerate(rows):
        key = (str(row.get("streamer_id") or row.get("user_id") or "").lower(),
               str(row.get("broadcast_no") or f"unkeyed-{i}"))
        unique[key] = row
    days = {}
    for row in unique.values():
        key = (str(row.get("streamer_id") or row.get("user_id") or "").lower(), row["reporting_date"])
        day = days.setdefault(key, {"streamer_id": key[0], "reporting_date": key[1], "today_balloons": 0, "groups": []})
        day["today_balloons"] += int(row.get("today_balloons") or 0)
        day["groups"].append(row.get("daily_fans") or [])
    return [{**{k: v for k, v in day.items() if k != "groups"}, "daily_fans": sum_fans(day["groups"])} for day in days.values()]
