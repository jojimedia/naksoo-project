"""Long-running, database-backed collector for Cloudtype.

It reuses the proven fetch/parsing functions in ``main.py``.  Google Sheets
remains the member source for now; only ranking state is moved to PostgreSQL.
"""

from __future__ import annotations

import argparse
import asyncio
import os
from datetime import datetime, timedelta
from typing import Any

import httpx

from main import (
    HEADERS,
    TIMEZONE,
    apply_member_sheet_metadata,
    fetch_live_status,
    fetch_one_member,
    fetch_station,
    get_calendar_period,
    retry,
)
from realtime_db import (
    claim_refresh_requests,
    cleanup_expired_data,
    complete_refresh_requests,
    ensure_schema,
    get_cached_result,
    get_collector_members,
    save_result,
    update_collector_status,
)


STATUS_POLL_SECONDS = max(30, int(os.environ.get("NAKSOO_STATUS_POLL_SECONDS", "120")))
HOT_POLL_SECONDS = max(30, int(os.environ.get("NAKSOO_HOT_POLL_SECONDS", "60")))
WARM_POLL_SECONDS = max(60, int(os.environ.get("NAKSOO_WARM_POLL_SECONDS", "180")))
COLD_POLL_SECONDS = max(120, int(os.environ.get("NAKSOO_COLD_POLL_SECONDS", "600")))
LOOP_SLEEP_SECONDS = max(5, int(os.environ.get("NAKSOO_WORKER_LOOP_SECONDS", "10")))


def make_output(now: datetime, members: list[dict[str, Any]], items: list[dict[str, Any]]) -> dict[str, Any]:
    calendar = get_calendar_period(now)
    active_ids = {
        (member["crew_name"], member["user_id"])
        for member in members
        if not member.get("is_on_leave")
    }
    items = [
        item for item in items
        if (item.get("crew_name"), item.get("user_id")) in active_ids
    ]
    items = apply_member_sheet_metadata(items, members, {**calendar, "calendar_current": calendar["current"]})
    items.sort(key=lambda item: (item["crew_name"], -int((item.get("current_month") or {}).get("total_balloons") or 0)))
    return {
        "project": "naksoo",
        "created_at": now.isoformat(),
        "created_date": now.strftime("%Y-%m-%d"),
        "created_time": now.strftime("%H:%M:%S"),
        "timezone": "Asia/Seoul",
        "current_period": calendar["current"],
        "previous_period": calendar["previous"],
        "older_period": calendar["older"],
        "calendar_current_period": calendar["current"],
        "used_month_fallback": any(item.get("current_month_used_fallback") for item in items),
        "count": len(items),
        "items": items,
    }


class RealtimeCollector:
    def __init__(self) -> None:
        self.next_status_at: dict[tuple[str, str], datetime] = {}
        self.next_detail_at: dict[tuple[str, str], datetime] = {}
        self.live_states: dict[tuple[str, str], bool] = {}
        self.last_change_at: dict[tuple[str, str], datetime] = {}
        self.last_cleanup_date = None

    async def _status_for_member(self, client, member: dict[str, Any]) -> tuple[bool, str | None, bool, str | None, str | None, int | None] | None:
        user_id = member["user_id"]
        try:
            station = await retry(lambda: fetch_station(client, user_id), retries=2, delay=1, label=f"{user_id} station")
            live_status = await retry(lambda: fetch_live_status(client, user_id), retries=2, delay=1, label=f"{user_id} live")
            # `station.broadStart` can remain populated after a broadcast has
            # ended.  It is useful display metadata but must not schedule a
            # high-frequency collection.  Only the live player endpoint is
            # authoritative for the collector.
            return (
                bool(live_status.get("is_live")),
                station.get("broadcast_start"),
                bool(live_status.get("is_password")),
                str(live_status["broadcast_no"]) if live_status.get("broadcast_no") else None,
                str(live_status["broadcast_title"]).strip() if live_status.get("broadcast_title") else None,
                # SOOP may return a formatted value such as "1,234". Keep
                # only digits instead of dropping the viewer count entirely.
                int("".join(ch for ch in str(live_status.get("viewer_count") or "") if ch.isdigit()))
                if any(ch.isdigit() for ch in str(live_status.get("viewer_count") or "")) else None,
            )
        except Exception as error:
            print(f"[{member['crew_name']}/{user_id}] live status failed: {error}")
            return None

    async def _bootstrap(self, members: list[dict[str, Any]], now: datetime) -> dict[str, Any]:
        """A first-run full snapshot, used only when DB cache is empty."""
        active = [member for member in members if not member.get("is_on_leave")]
        calendar = get_calendar_period(now)
        period = {"now": now, **calendar, "calendar_current": calendar["current"]}
        semaphore = asyncio.Semaphore(2)
        fan_cache: dict[str, Any] = {}
        fan_lock = asyncio.Lock()
        fan_semaphore = asyncio.Semaphore(8)
        ranking_cache: dict[str, Any] = {}
        async with httpx.AsyncClient(follow_redirects=True, timeout=15, headers=HEADERS) as client:
            items = await asyncio.gather(*(
                fetch_one_member(client, member, period, ranking_cache, semaphore, fan_cache, fan_lock, fan_semaphore)
                for member in active
            ))
        existing = [item for item in items if item.get("success")]
        if not existing:
            raise RuntimeError("Bootstrap failed for every active member.")
        return make_output(now, members, existing)

    async def run_cycle(self) -> None:
        now = datetime.now(TIMEZONE)
        requested_refreshes = claim_refresh_requests()
        try:
            members = get_collector_members()
            if not members:
                raise RuntimeError("PostgreSQL members 테이블이 비어 있습니다.")

            cached = get_cached_result()
            calendar = get_calendar_period(now)
            older = calendar["older"]
            older_cache_key = f"period:{older['year']}-{older['month']:02d}"
            cached_member_keys = {
                (str(item.get("crew_name") or ""), str(item.get("user_id") or ""))
                for item in (cached or {}).get("items") or []
            }
            database_member_keys = {
                (str(member.get("crew_name") or ""), str(member.get("user_id") or ""))
                for member in members
            }
            membership_changed = cached_member_keys != database_member_keys
            if requested_refreshes or membership_changed or not cached or not get_cached_result(older_cache_key):
                reason = "membership changed" if membership_changed else "bootstrap/administrator refresh requested"
                print(f"{reason}; rebuilding member ranking cache.")
                output = await self._bootstrap(members, now)
                save_result(output, now)
                complete_refresh_requests(requested_refreshes)
                update_collector_status(now)
                return

            items_by_key = {
                (item.get("crew_name"), item.get("user_id")): dict(item)
                for item in cached.get("items") or []
            }
            active_members = [member for member in members if not member.get("is_on_leave")]
            to_collect: list[dict[str, Any]] = []

            if requested_refreshes:
                # The administrator requested a refresh.  Force the next status
                # and detail checks without adding a separate HTTP API to Worker.
                for member in active_members:
                    key = (member["crew_name"], member["user_id"])
                    self.next_status_at[key] = now
                    self.next_detail_at[key] = now

            async with httpx.AsyncClient(follow_redirects=True, timeout=15, headers=HEADERS) as client:
                for member in active_members:
                    key = (member["crew_name"], member["user_id"])
                    if now < self.next_status_at.get(key, now):
                        continue
                    self.next_status_at[key] = now + timedelta(seconds=STATUS_POLL_SECONDS)
                    status = await self._status_for_member(client, member)
                    if status is None:
                        continue  # retain the last known state on an API failure

                    is_live, broadcast_start, is_password, broadcast_no, broadcast_title, viewer_count = status
                    # Do not trust a pre-restart cache value for a final sample.
                    # It could have been marked live by an old/stale station API.
                    was_live = self.live_states.get(key, False)
                    self.live_states[key] = is_live
                    existing = items_by_key.get(key)
                    if existing:
                        existing["is_live"] = is_live
                        existing["broadcast_start"] = broadcast_start if is_live else None
                        existing["is_password_broadcast"] = is_password
                        existing["broadcast_no"] = broadcast_no if is_live else None
                        existing["broadcast_title"] = broadcast_title if is_live else None
                        existing["viewer_count"] = viewer_count if is_live else None

                    due = self.next_detail_at.get(key, now)
                    if is_live and (not was_live or now >= due):
                        to_collect.append(member)
                    elif was_live and not is_live:
                        # One final sample after the broadcast ends.
                        to_collect.append(member)

                if to_collect:
                    calendar = get_calendar_period(now)
                    period = {"now": now, **calendar, "calendar_current": calendar["current"]}
                    semaphore = asyncio.Semaphore(2)
                    fan_cache: dict[str, Any] = {}
                    fan_lock = asyncio.Lock()
                    fan_semaphore = asyncio.Semaphore(8)
                    ranking_cache: dict[str, Any] = {}
                    fetched = await asyncio.gather(*(
                        fetch_one_member(
                            client,
                            member,
                            period,
                            ranking_cache,
                            semaphore,
                            fan_cache,
                            fan_lock,
                            fan_semaphore,
                        )
                        for member in to_collect
                    ))
                    for item in fetched:
                        if not item.get("success"):
                            continue
                        key = (item["crew_name"], item["user_id"])
                        previous_total = int(((items_by_key.get(key) or {}).get("current_month") or {}).get("total_balloons") or 0)
                        current_total = int((item.get("current_month") or {}).get("total_balloons") or 0)
                        if current_total > previous_total:
                            self.last_change_at[key] = now
                            interval = HOT_POLL_SECONDS
                        elif now - self.last_change_at.get(key, now - timedelta(seconds=COLD_POLL_SECONDS)) < timedelta(minutes=10):
                            interval = WARM_POLL_SECONDS
                        else:
                            interval = COLD_POLL_SECONDS
                        self.next_detail_at[key] = now + timedelta(seconds=interval)
                        items_by_key[key] = item

            output = make_output(now, members, list(items_by_key.values()))
            save_result(output, now)
            complete_refresh_requests(requested_refreshes)
            update_collector_status(now)
            if self.last_cleanup_date != now.date():
                cleanup_expired_data(now)
                self.last_cleanup_date = now.date()
            print(f"Cycle saved: live refreshes={len(to_collect)}, total items={output['count']}")
        except Exception as error:
            complete_refresh_requests(requested_refreshes, str(error))
            update_collector_status(now, str(error))
            raise

    async def run_forever(self) -> None:
        while True:
            try:
                await self.run_cycle()
            except Exception as error:
                print(f"Worker cycle failed: {type(error).__name__}: {error}")
                update_collector_status(datetime.now(TIMEZONE), str(error))
            await asyncio.sleep(LOOP_SLEEP_SECONDS)


async def run(once: bool) -> None:
    ensure_schema()
    collector = RealtimeCollector()
    if once:
        await collector.run_cycle()
    else:
        await collector.run_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="Run one collection cycle and exit")
    arguments = parser.parse_args()
    asyncio.run(run(arguments.once))
