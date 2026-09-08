"""Long-running, database-backed collector for Cloudtype."""

from __future__ import annotations

import argparse
import asyncio
import os
import random
import socket
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
    acquire_collector_lease,
    claim_refresh_requests,
    cleanup_expired_data,
    complete_refresh_requests,
    ensure_schema,
    get_cached_result,
    get_collector_members,
    get_collector_state,
    mark_recovery_sweep,
    recovery_sweep_due,
    save_result,
    update_collector_status,
)


STATUS_POLL_SECONDS = max(30, int(os.environ.get("NAKSOO_STATUS_POLL_SECONDS", "120")))
STATUS_POLL_JITTER_SECONDS = max(0, int(os.environ.get("NAKSOO_STATUS_POLL_JITTER_SECONDS", "30")))
STATUS_CONCURRENCY = max(1, int(os.environ.get("NAKSOO_STATUS_CONCURRENCY", "10")))
HOT_POLL_SECONDS = max(30, int(os.environ.get("NAKSOO_HOT_POLL_SECONDS", "60")))
HOT_POLL_JITTER_SECONDS = max(0, int(os.environ.get("NAKSOO_HOT_POLL_JITTER_SECONDS", "30")))
WARM_POLL_SECONDS = max(60, int(os.environ.get("NAKSOO_WARM_POLL_SECONDS", "180")))
WARM_POLL_JITTER_SECONDS = max(0, int(os.environ.get("NAKSOO_WARM_POLL_JITTER_SECONDS", "45")))
COLD_POLL_SECONDS = max(120, int(os.environ.get("NAKSOO_COLD_POLL_SECONDS", "600")))
COLD_POLL_JITTER_SECONDS = max(0, int(os.environ.get("NAKSOO_COLD_POLL_JITTER_SECONDS", "90")))
UNAVAILABLE_RETRY_SECONDS = max(60, int(os.environ.get("NAKSOO_UNAVAILABLE_RETRY_SECONDS", "300")))
LOOP_SLEEP_SECONDS = max(5, int(os.environ.get("NAKSOO_WORKER_LOOP_SECONDS", "10")))
# A cold start or an administrator-triggered full refresh has to collect every
# active member.  Start quickly in batches, then retry only the members that
# actually failed with a gentler request rate.  This keeps one slow/blocked
# source from making the whole dashboard wait serially.
BOOTSTRAP_CONCURRENCY = max(1, int(os.environ.get("NAKSOO_BOOTSTRAP_CONCURRENCY", "10")))
# Keep member/station work responsive while limiting only the static 풍투
# endpoints, which are more sensitive to burst traffic.
BALLOON_SOURCE_CONCURRENCY = max(1, int(os.environ.get("NAKSOO_BALLOON_SOURCE_CONCURRENCY", "4")))
BOOTSTRAP_RETRY_CONCURRENCY = max(1, int(os.environ.get("NAKSOO_BOOTSTRAP_RETRY_CONCURRENCY", "2")))
BOOTSTRAP_RETRY_DELAY_SECONDS = max(0, int(os.environ.get("NAKSOO_BOOTSTRAP_RETRY_DELAY_SECONDS", "15")))
RECOVERY_CONCURRENCY = max(1, int(os.environ.get("NAKSOO_RECOVERY_CONCURRENCY", "2")))
RECOVERY_RETRY_CONCURRENCY = max(1, int(os.environ.get("NAKSOO_RECOVERY_RETRY_CONCURRENCY", "1")))
RECOVERY_RETRY_DELAY_SECONDS = max(0, int(os.environ.get("NAKSOO_RECOVERY_RETRY_DELAY_SECONDS", "30")))
COLLECTOR_LEASE_SECONDS = max(60, int(os.environ.get("NAKSOO_COLLECTOR_LEASE_SECONDS", "600")))


def _interval(base_seconds: int, jitter_seconds: int = 0) -> int:
    """Return a positive collection interval with a one-sided random jitter."""

    return base_seconds + random.randint(0, jitter_seconds)


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
        self.holder = f"{socket.gethostname()}:{os.getpid()}"
        self.next_status_at: dict[tuple[str, str], datetime] = {}
        self.next_detail_at: dict[tuple[str, str], datetime] = {}
        self.live_states: dict[tuple[str, str], bool] = {}
        self.last_change_at: dict[tuple[str, str], datetime] = {}
        self.last_cleanup_date = None
        self.state_restored = False

    def _restore_state(self, now: datetime) -> None:
        if self.state_restored:
            return
        state = get_collector_state(now.year, now.month)
        for key, value in state.items():
            self.live_states[key] = bool(value["is_live"])
            last_changed_at = value.get("last_changed_at")
            if isinstance(last_changed_at, datetime):
                self.last_change_at[key] = last_changed_at
        self.state_restored = True
        print(f"Restored collector scheduling state for {len(state)} members.")

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

    async def _bootstrap(
        self,
        members: list[dict[str, Any]],
        now: datetime,
        concurrency: int = BOOTSTRAP_CONCURRENCY,
        retry_concurrency: int = BOOTSTRAP_RETRY_CONCURRENCY,
        retry_delay_seconds: int = BOOTSTRAP_RETRY_DELAY_SECONDS,
    ) -> dict[str, Any]:
        """Build a full snapshot with a fast pass and a limited retry pass."""
        active = [member for member in members if not member.get("is_on_leave")]
        calendar = get_calendar_period(now)
        period = {"now": now, **calendar, "calendar_current": calendar["current"]}
        fan_cache: dict[str, Any] = {}
        fan_lock = asyncio.Lock()
        fan_semaphore = asyncio.Semaphore(8)
        balloon_semaphore = asyncio.Semaphore(BALLOON_SOURCE_CONCURRENCY)
        ranking_cache: dict[str, Any] = {}
        async with httpx.AsyncClient(follow_redirects=True, timeout=15, headers=HEADERS) as client:
            initial_semaphore = asyncio.Semaphore(concurrency)
            items = await asyncio.gather(*(
                fetch_one_member(client, member, period, ranking_cache, initial_semaphore, fan_cache, fan_lock, fan_semaphore, balloon_semaphore)
                for member in active
            ))

            failed_keys = {
                (str(item.get("crew_name") or ""), str(item.get("user_id") or ""))
                for item in items
                if not item.get("success") or item.get("current_month_used_fallback")
            }
            if failed_keys:
                retry_members = [
                    member for member in active
                    if (str(member["crew_name"]), str(member["user_id"])) in failed_keys
                ]
                print(
                    f"Bootstrap first pass complete; retrying {len(retry_members)} failed members "
                    f"at concurrency {retry_concurrency}."
                )
                if retry_delay_seconds:
                    await asyncio.sleep(retry_delay_seconds)
                retry_semaphore = asyncio.Semaphore(retry_concurrency)
                retried_items = await asyncio.gather(*(
                    fetch_one_member(client, member, period, ranking_cache, retry_semaphore, fan_cache, fan_lock, fan_semaphore, balloon_semaphore)
                    for member in retry_members
                ))
                retry_by_key = {
                    (str(item.get("crew_name") or ""), str(item.get("user_id") or "")): item
                    for item in retried_items
                    if item.get("success") and not item.get("current_month_used_fallback")
                }
                items = [
                    retry_by_key.get((str(item.get("crew_name") or ""), str(item.get("user_id") or "")), item)
                    for item in items
                ]
        existing = [item for item in items if item.get("success")]
        if not existing:
            raise RuntimeError("Bootstrap failed for every active member.")
        return make_output(now, members, existing)

    async def run_cycle(self) -> None:
        now = datetime.now(TIMEZONE)
        if not acquire_collector_lease(self.holder, COLLECTOR_LEASE_SECONDS):
            print("Another collector holds the PostgreSQL lease; skipping this cycle.")
            return

        requested_refreshes = claim_refresh_requests()
        try:
            members = get_collector_members()
            if not members:
                raise RuntimeError("PostgreSQL members 테이블이 비어 있습니다.")
            self._restore_state(now)

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
            if not cached or not get_cached_result(older_cache_key):
                print("Ranking cache is not ready; building initial member snapshot.")
                output = await self._bootstrap(members, now)
                save_result(output, now)
                complete_refresh_requests(requested_refreshes)
                update_collector_status(now)
                return

            recovery_due = recovery_sweep_due(now)
            if membership_changed:
                added = database_member_keys - cached_member_keys
                removed = cached_member_keys - database_member_keys
                print(f"Membership changed; incremental sync (added={len(added)}, removed={len(removed)}).")
            if recovery_due:
                print("Daily recovery sweep; refreshing live status and unresolved members only.")

            items_by_key = {
                (item.get("crew_name"), item.get("user_id")): dict(item)
                for item in cached.get("items") or []
            }
            active_members = [member for member in members if not member.get("is_on_leave")]
            to_collect: list[dict[str, Any]] = []

            if requested_refreshes or recovery_due:
                # An administrator request or the daily sweep refreshes the
                # status of every registered member.  It intentionally does
                # not refetch all three monthly periods for every member.
                for member in active_members:
                    key = (member["crew_name"], member["user_id"])
                    self.next_status_at[key] = now

            async with httpx.AsyncClient(follow_redirects=True, timeout=15, headers=HEADERS) as client:
                status_members: list[dict[str, Any]] = []
                for member in active_members:
                    key = (member["crew_name"], member["user_id"])
                    if now < self.next_status_at.get(key, now):
                        continue
                    self.next_status_at[key] = now + timedelta(
                        seconds=_interval(STATUS_POLL_SECONDS, STATUS_POLL_JITTER_SECONDS)
                    )
                    status_members.append(member)

                status_semaphore = asyncio.Semaphore(STATUS_CONCURRENCY)

                async def check_status(member: dict[str, Any]):
                    async with status_semaphore:
                        return member, await self._status_for_member(client, member)

                for member, status in await asyncio.gather(*(check_status(member) for member in status_members)):
                    if status is None:
                        continue  # retain the last known state on an API failure

                    key = (member["crew_name"], member["user_id"])
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
                    if existing is None:
                        # A newly added member needs one initial three-month
                        # snapshot whether or not they are currently LIVE.
                        to_collect.append(member)
                    elif is_live and (not was_live or now >= due):
                        to_collect.append(member)
                    elif was_live and not is_live:
                        # One final sample after the broadcast ends.
                        to_collect.append(member)
                    elif existing and existing.get("current_month_used_fallback") and now >= due:
                        # Newly registered/offline members can also hit a
                        # transient source block during the initial snapshot.
                        # Retry only those unresolved rows at a low rate; do
                        # not wait until the next daily recovery sweep.
                        to_collect.append(member)

                if to_collect:
                    calendar = get_calendar_period(now)
                    period = {"now": now, **calendar, "calendar_current": calendar["current"]}
                    semaphore = asyncio.Semaphore(2)
                    fan_cache: dict[str, Any] = {}
                    fan_lock = asyncio.Lock()
                    fan_semaphore = asyncio.Semaphore(8)
                    balloon_semaphore = asyncio.Semaphore(BALLOON_SOURCE_CONCURRENCY)
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
                            balloon_semaphore,
                        )
                        for member in to_collect
                    ))
                    for item in fetched:
                        if not item.get("success"):
                            continue
                        key = (item["crew_name"], item["user_id"])
                        if item.get("current_month_used_fallback"):
                            # Keep the last known monthly total when 풍투 is
                            # temporarily blocked.  This member remains due
                            # for a short retry instead of poisoning the cache
                            # with an `unavailable` zero.
                            retry_seconds = (
                                _interval(HOT_POLL_SECONDS, HOT_POLL_JITTER_SECONDS)
                                if item.get("is_live")
                                else UNAVAILABLE_RETRY_SECONDS
                            )
                            self.next_detail_at[key] = now + timedelta(seconds=retry_seconds)
                            # Keep a newly added member visible and mark it
                            # unresolved. Existing members retain their last
                            # normal monthly value instead.
                            if key not in items_by_key:
                                items_by_key[key] = item
                            print(f"[{key[0]}/{key[1]}] monthly source unavailable; retaining last known cache.")
                            continue
                        previous_total = int(((items_by_key.get(key) or {}).get("current_month") or {}).get("total_balloons") or 0)
                        current_total = int((item.get("current_month") or {}).get("total_balloons") or 0)
                        if current_total > previous_total:
                            self.last_change_at[key] = now
                            interval = _interval(HOT_POLL_SECONDS, HOT_POLL_JITTER_SECONDS)
                        elif now - self.last_change_at.get(key, now - timedelta(seconds=COLD_POLL_SECONDS)) < timedelta(minutes=10):
                            interval = _interval(WARM_POLL_SECONDS, WARM_POLL_JITTER_SECONDS)
                        else:
                            interval = _interval(COLD_POLL_SECONDS, COLD_POLL_JITTER_SECONDS)
                        self.next_detail_at[key] = now + timedelta(seconds=interval)
                        items_by_key[key] = item

            output = make_output(now, members, list(items_by_key.values()))
            save_result(output, now)
            if recovery_due:
                mark_recovery_sweep(now)
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
