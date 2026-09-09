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
    build_month_data,
    fetch_balloon,
    fetch_live_status,
    fetch_one_member,
    fetch_station,
    get_calendar_period,
    is_month_data_available,
    is_poong_not_found_response,
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
    record_source_collection_result,
    recovery_sweep_due,
    save_result,
    update_collector_status,
)


STATUS_POLL_SECONDS = max(30, int(os.environ.get("NAKSOO_STATUS_POLL_SECONDS", "60")))
# Keep a small spread so 123 status requests do not arrive at once, while
# still detecting a newly LIVE streamer within roughly one minute.
STATUS_POLL_JITTER_SECONDS = max(0, int(os.environ.get("NAKSOO_STATUS_POLL_JITTER_SECONDS", "5")))
STATUS_CONCURRENCY = max(1, int(os.environ.get("NAKSOO_STATUS_CONCURRENCY", "10")))
HOT_POLL_SECONDS = max(30, int(os.environ.get("NAKSOO_HOT_POLL_SECONDS", "60")))
HOT_POLL_JITTER_SECONDS = max(0, int(os.environ.get("NAKSOO_HOT_POLL_JITTER_SECONDS", "5")))
WARM_POLL_SECONDS = max(60, int(os.environ.get("NAKSOO_WARM_POLL_SECONDS", "180")))
WARM_POLL_JITTER_SECONDS = max(0, int(os.environ.get("NAKSOO_WARM_POLL_JITTER_SECONDS", "45")))
COLD_POLL_SECONDS = max(120, int(os.environ.get("NAKSOO_COLD_POLL_SECONDS", "600")))
COLD_POLL_JITTER_SECONDS = max(0, int(os.environ.get("NAKSOO_COLD_POLL_JITTER_SECONDS", "90")))
# A full 풍투 reconciliation protects against a missed/stale SOOP LIVE
# signal, without turning every offline streamer into a frequent poll.
FULL_RECONCILIATION_SECONDS = max(
    300, int(os.environ.get("NAKSOO_FULL_RECONCILIATION_SECONDS", "7200"))
)
UNAVAILABLE_RETRY_SECONDS = max(60, int(os.environ.get("NAKSOO_UNAVAILABLE_RETRY_SECONDS", "300")))
# Recover missing donor lists promptly after a temporary source block. The
# actual monthly requests remain capped by the two-wide detail semaphore.
DETAIL_BACKFILL_BATCH_SIZE = max(1, int(os.environ.get("NAKSOO_DETAIL_BACKFILL_BATCH_SIZE", "5")))
DETAIL_BACKFILL_INTERVAL_SECONDS = max(30, int(os.environ.get("NAKSOO_DETAIL_BACKFILL_INTERVAL_SECONDS", "30")))
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


def _needs_detail_backfill(item: dict[str, Any]) -> bool:
    """chart/get has totals but no per-streamer donor list."""

    month = item.get("current_month") or {}
    return (
        month.get("data_source") in {"chart_ranking", "unavailable"}
        # A zero-total month has no donor list by definition. Retrying those
        # rows only wastes the small recovery budget needed by real donors.
        and int(month.get("total_balloons") or 0) > 0
        and not month.get("fans")
    )


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
        self.next_detail_backfill_at: datetime | None = None
        self.next_donor_backfill_for: dict[tuple[str, str], datetime] = {}
        # ``None`` deliberately makes a newly deployed/restarted collector
        # reconcile all existing members once before returning to live-only
        # polling.
        self.next_full_reconciliation_at: datetime | None = None
        self.recovery_required: set[tuple[str, str]] = set()

    def _restore_state(self, now: datetime) -> None:
        if self.state_restored:
            return
        state = get_collector_state(now.year, now.month)
        for key, value in state.items():
            self.live_states[key] = bool(value["is_live"])
            last_changed_at = value.get("last_changed_at")
            if isinstance(last_changed_at, datetime):
                self.last_change_at[key] = last_changed_at
            last_live_end_at = value.get("last_live_end_at")
            last_detail_collected_at = value.get("last_detail_collected_at")
            if (
                isinstance(last_live_end_at, datetime)
                and (not isinstance(last_detail_collected_at, datetime) or last_live_end_at > last_detail_collected_at)
            ):
                self.recovery_required.add(key)
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

    async def _backfill_donors(
        self,
        client: httpx.AsyncClient,
        member: dict[str, Any],
        calendar_current: dict[str, int],
        balloon_semaphore: asyncio.Semaphore,
    ) -> tuple[tuple[str, str], dict[str, Any] | None]:
        """Fetch only the one missing donor payload, not a full member scan.

        A full scan also requests station/live, three months and up to fifty
        donor profiles. That made offline donor recovery wait behind live
        polling indefinitely. The existing member snapshot already has all of
        that metadata; this path needs only current-month ``detail/get``.
        """

        key = (member["crew_name"], member["user_id"])
        year = int(calendar_current["year"])
        month = int(calendar_current["month"])
        try:
            async with balloon_semaphore:
                data = await retry(
                    lambda: fetch_balloon(client, member["user_id"], year, month),
                    retries=2,
                    delay=1,
                    label=f"{key[0]}/{key[1]} donor backfill {year}-{month}",
                )
            if is_poong_not_found_response(data) or not is_month_data_available(data):
                return key, None
            recovered = build_month_data(data, year, month)
            recovered["data_source"] = "detail"
            print(f"[{key[0]}/{key[1]}] donor detail recovered fans={len(recovered['fans'])}")
            return key, recovered
        except Exception as error:
            print(f"[{key[0]}/{key[1]}] donor detail backfill failed: {error}")
            return key, None

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
                self.next_full_reconciliation_at = now + timedelta(
                    seconds=FULL_RECONCILIATION_SECONDS
                )
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
            # Only brand-new members need the expensive three-month bootstrap.
            # Existing members are refreshed below with one current-month
            # detail request, preserving the historical snapshots already in
            # PostgreSQL.
            to_collect: list[dict[str, Any]] = []
            quick_collect: list[dict[str, Any]] = []

            scheduled_reconciliation = (
                self.next_full_reconciliation_at is None
                or now >= self.next_full_reconciliation_at
            )
            full_current_month_refresh = bool(requested_refreshes) or scheduled_reconciliation
            if scheduled_reconciliation:
                self.next_full_reconciliation_at = now + timedelta(
                    seconds=FULL_RECONCILIATION_SECONDS
                )
            if full_current_month_refresh or recovery_due:
                # An administrator request or the daily sweep refreshes the
                # status of every registered member.  Historical months stay
                # immutable here; the current-month total is handled below.
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
                    elif was_live and not is_live:
                        # One final sample after the broadcast ends.
                        existing["last_live_end_at"] = now.isoformat()
                        self.recovery_required.add(key)
                        quick_collect.append(member)
                    elif key in self.recovery_required:
                        # A previous process stopped after a broadcast ended
                        # but before its final 풍투 read completed.
                        quick_collect.append(member)
                    elif existing and (existing.get("current_month") or {}).get("data_source") == "unavailable" and now >= due:
                        # Newly registered/offline members can also hit a
                        # transient source block during the initial snapshot.
                        # Retry only those unresolved rows at a low rate; do
                        # not wait until the next daily recovery sweep.
                        quick_collect.append(member)

                # Reconcile the current month at collector start, on a manual
                # update, and every two hours by default. This catches a
                # missed/stale SOOP LIVE signal without polling every offline
                # member at the live cadence. New members still use the full
                # bootstrap path above to obtain their historical months.
                if full_current_month_refresh:
                    bootstrap_keys = {
                        (member["crew_name"], member["user_id"])
                        for member in to_collect
                    }
                    quick_keys = {
                        (member["crew_name"], member["user_id"])
                        for member in quick_collect
                    }
                    for member in active_members:
                        key = (member["crew_name"], member["user_id"])
                        if key not in bootstrap_keys and key not in quick_keys:
                            quick_collect.append(member)
                            quick_keys.add(key)
                    reason = "manual refresh" if requested_refreshes else "scheduled reconciliation"
                    print(
                        f"{reason}: reconciling current-month 풍투 totals "
                        f"for {len(quick_collect)} existing members."
                    )

                # Status polling is intentionally slower than live detail
                # polling. Outside of the periodic reconciliation, use the
                # cached live state so only LIVE members are refreshed at the
                # faster 60–90 second cadence.
                quick_keys = {(member["crew_name"], member["user_id"]) for member in quick_collect}
                for member in active_members:
                    key = (member["crew_name"], member["user_id"])
                    if key in quick_keys or key not in items_by_key:
                        continue
                    if self.live_states.get(key, False) and now >= self.next_detail_at.get(key, now):
                        quick_collect.append(member)
                        quick_keys.add(key)
                # Donor-detail backfill is independent of the 2-minute live
                # status poll. Otherwise offline members would wait for a
                # status turn before every retry.
                selected_backfills: list[dict[str, Any]] = []
                if self.next_detail_backfill_at is None or now >= self.next_detail_backfill_at:
                    already_collecting = {
                        (member["crew_name"], member["user_id"])
                        for member in (to_collect + quick_collect)
                    }
                    detail_backfill_candidates = [
                        member
                        for member in active_members
                        if (member["crew_name"], member["user_id"]) not in already_collecting
                        and _needs_detail_backfill(
                            items_by_key.get((member["crew_name"], member["user_id"])) or {}
                        )
                        and now >= self.next_donor_backfill_for.get(
                            (member["crew_name"], member["user_id"]), now
                        )
                    ]
                    if detail_backfill_candidates:
                        # This is deliberately separate from ``to_collect``.
                        # Previously live polling could fill the five slots,
                        # leaving every offline donor backfill at zero work.
                        selected_backfills = detail_backfill_candidates[:DETAIL_BACKFILL_BATCH_SIZE]
                        # A failed detail attempt must not monopolize the next
                        # batch. Try another empty member first, then retry
                        # this one after five minutes.
                        for member in selected_backfills:
                            self.next_donor_backfill_for[
                                (member["crew_name"], member["user_id"])
                            ] = now + timedelta(seconds=UNAVAILABLE_RETRY_SECONDS)
                        self.next_detail_backfill_at = now + timedelta(
                            seconds=DETAIL_BACKFILL_INTERVAL_SECONDS
                        )

                # Existing LIVE members and missing donor rows use the same
                # lightweight path: exactly one current-month detail/get
                # request. Do not re-run the three-month bootstrap or donor
                # profile lookups for every live refresh.
                direct_collect = quick_collect + selected_backfills
                if direct_collect:
                    calendar = get_calendar_period(now)
                    donor_semaphore = asyncio.Semaphore(RECOVERY_CONCURRENCY)
                    recovered_months = await asyncio.gather(*(
                        self._backfill_donors(client, member, calendar["current"], donor_semaphore)
                        for member in direct_collect
                    ))
                    selected_backfill_keys = {
                        (member["crew_name"], member["user_id"])
                        for member in selected_backfills
                    }
                    for key, recovered_month in recovered_months:
                        record_source_collection_result(recovered_month is not None, now)
                        if recovered_month is None:
                            # Preserve known data; only the next attempt is
                            # delayed. This must never turn a good donor list
                            # into an empty chart fallback.
                            self.next_detail_at[key] = now + timedelta(
                                seconds=(
                                    UNAVAILABLE_RETRY_SECONDS
                                    if key in selected_backfill_keys
                                    else _interval(HOT_POLL_SECONDS, HOT_POLL_JITTER_SECONDS)
                                )
                            )
                            continue
                        existing = items_by_key.get(key)
                        if existing is None:
                            continue
                        previous_total = int((existing.get("current_month") or {}).get("total_balloons") or 0)
                        existing["current_month"] = recovered_month
                        existing["current_month_used_fallback"] = False
                        existing["last_detail_collected_at"] = now.isoformat()
                        items_by_key[key] = existing
                        self.next_donor_backfill_for.pop(key, None)
                        self.recovery_required.discard(key)
                        if self.live_states.get(key, False) or int(recovered_month.get("total_balloons") or 0) > previous_total:
                            interval = _interval(HOT_POLL_SECONDS, HOT_POLL_JITTER_SECONDS)
                        else:
                            interval = _interval(COLD_POLL_SECONDS, COLD_POLL_JITTER_SECONDS)
                        self.next_detail_at[key] = now + timedelta(seconds=interval)

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
                        if (item.get("current_month") or {}).get("data_source") == "unavailable":
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
                        previous_item = items_by_key.get(key) or {}
                        previous_month = previous_item.get("current_month") or {}
                        current_month = item.get("current_month") or {}
                        # chart/get only has a monthly total.  Do not erase a
                        # previously collected detail/get donor list just
                        # because this one cycle fell back to chart/get.
                        if (
                            current_month.get("data_source") == "chart_ranking"
                            and not current_month.get("fans")
                            and previous_month.get("fans")
                        ):
                            current_month["fans"] = previous_month["fans"]
                        previous_total = int(previous_month.get("total_balloons") or 0)
                        current_total = int((item.get("current_month") or {}).get("total_balloons") or 0)
                        if _needs_detail_backfill(item):
                            # It has a usable monthly total but no donor rows.
                            # Put this member back in the low-rate backlog.
                            self.next_detail_at[key] = now + timedelta(
                                seconds=UNAVAILABLE_RETRY_SECONDS
                            )
                            items_by_key[key] = item
                            continue
                        self.next_donor_backfill_for.pop(key, None)
                        if item.get("is_live"):
                            # A LIVE stream is the user-facing real-time path:
                            # keep checking detail/get every 60–90 seconds,
                            # even during a quiet minute with no new balloons.
                            if current_total > previous_total:
                                self.last_change_at[key] = now
                            interval = _interval(HOT_POLL_SECONDS, HOT_POLL_JITTER_SECONDS)
                        elif current_total > previous_total:
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
            print(
                f"Cycle saved: bootstrap={len(to_collect)}, "
                f"current-detail={len(quick_collect) + len(selected_backfills)}, "
                f"total items={output['count']}"
            )
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
