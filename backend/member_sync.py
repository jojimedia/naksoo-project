"""Keep collector statistics keyed by SOOP ID while membership changes."""

_EMPTY_MONTH = {"total_balloons": 0, "daily_balloons": [], "fans": []}


def align_members(items, members):
    """Apply authoritative membership, including not-yet-collected IDs."""

    existing = {
        str(item.get("user_id", "")).lower(): item
        for item in items
        if item.get("user_id")
    }
    output = []
    seen = set()
    for member in members:
        user_id = str(member.get("user_id") or "")
        key = user_id.lower()
        if not key or key in seen:
            continue
        seen.add(key)
        item = existing.get(key)
        if item is None:
            item = {
                "success": True,
                "pending_collection": True,
                "is_live": False,
                "current_month": dict(_EMPTY_MONTH),
                "previous_month": dict(_EMPTY_MONTH),
                "older_month": dict(_EMPTY_MONTH),
            }
        output.append(
            {
                **item,
                "user_id": user_id,
                "crew_name": member["crew_name"],
                "nickname": member.get("nickname") or item.get("nickname") or user_id,
                "note": member.get("note", ""),
                "is_on_leave": member.get("is_on_leave", False),
                "success": True,
            }
        )
    return output
