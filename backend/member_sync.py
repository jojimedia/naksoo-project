"""Keep collector statistics keyed by SOOP ID while membership changes."""


def align_members(items, members):
    """Apply authoritative membership without inventing uncollected rows.

    Crew transfers retain the existing payload because statistics belong to
    the SOOP ID. Deleted members disappear immediately. Brand-new IDs are
    added only after the isolated bootstrap has produced their first payload.
    """

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
            continue
        output.append(
            {
                **item,
                "user_id": user_id,
                "crew_name": member["crew_name"],
                # SOOP ID is the stable identity. Nicknames are mutable
                # profile data, so a successful crawl must win over the
                # registration-time value kept in the members table.
                "nickname": item.get("nickname") or member.get("nickname") or user_id,
                "note": member.get("note", ""),
                "is_on_leave": member.get("is_on_leave", False),
            }
        )
    return output
