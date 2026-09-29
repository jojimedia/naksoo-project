"""Display confidence expires independently of donation/session lifecycle."""
from datetime import datetime
from live_totals import KST

STATUS_TTL_SECONDS = 120


def display_status(status, now=None):
    now = now or datetime.now(KST)
    try:
        checked = datetime.fromisoformat(str(status.get("status_observed_at")))
        if checked.tzinfo is None:
            checked = checked.replace(tzinfo=KST)
        age = (now - checked).total_seconds()
        fresh = -5 <= age <= STATUS_TTL_SECONDS
    except (ValueError, TypeError):
        fresh = False
    return {**status, "is_live": bool(status.get("is_live")) and fresh,
            "status_stale": not fresh}
