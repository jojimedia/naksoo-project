"""Long-running, database-backed collector for Cloudtype."""

from __future__ import annotations

import argparse
import asyncio
import os
import random
import socket
from copy import deepcopy
from datetime import datetime, timedelta
from typing import Any

import httpx
import uvicorn
from live_totals import POLL_SECONDS, apply_totals, fetch_totals, saved_totals
from member_sync import align_members
from poonggo_live import PoonggoLiveService, create_live_app

from main import (
    HEADERS,
    TIMEZONE,
    apply_member_sheet_metadata,
    build_month_data,
    fetch_balloon,
    fetch_live_status,
    fetch_poonggo_live_status,
    fetch_public_live_ids,
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


STATUS_POLL_SECONDS = max(30, int(os.environ.get("NAKSOO_STATUS_POLL_SECONDS", "30")))
# Jitter applies to the legacy one-shot cycle. The independent status lane
# bounds concurrency and schedules rounds separately from detail collection.
STATUS_POLL_JITTER_SECONDS = max(0, int(os.environ.get("NAKSOO_STATUS_POLL_JITTER_SECONDS", "5")))
STATUS_CONCURRENCY = max(1, int(os.environ.get("NAKSOO_STATUS_CONCURRENCY", "10")))
HOT_POLL_SECONDS = max(120, int(os.environ.get("NAKSOO_HOT_POLL_SECONDS", "300")))
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
# Ten minutes made a rolling deployment appear healthy while the replacement
# worker was unable to publish status or cache updates until the dead pod's
# lease expired.  All owner loops renew far more frequently than this.
COLLECTOR_LEASE_SECONDS = max(60, int(os.environ.get("NAKSOO_COLLECTOR_LEASE_SECONDS", "90")))


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


def _empty_month(period: dict[str, int]) -> dict[str, Any]:
    """Return a safe, explicitly dated placeholder for an uncollected month."""

    return {
        "year": int(period["year"]),
        "month": int(period["month"]),
        "total_balloons": 0,
        "daily_balloons": [],
        "daily_session_balloons": [],
        "daily_session_fans": [],
        "fans": [],
        "data_source": "unavailable",
    }


def align_item_periods(
    items: list[dict[str, Any]], calendar: dict[str, dict[str, int]]
) -> list[dict[str, Any]]:
    """Rotate cached month slots by their embedded year/month.

    The top-level cache period advances at midnight, but a cached item can
    still have September in ``current_month`` until its first successful
    October source response.  Slot names are therefore never trusted across
    a calendar boundary; the embedded period is authoritative.
    """

    aligned = []
    slot_names = ("current_month", "previous_month", "older_month")
    targets = (
        ("current_month", calendar["current"]),
        ("previous_month", calendar["previous"]),
        ("older_month", calendar["older"]),
    )
    for original in items:
        item = dict(original)
        by_period: dict[tuple[int, int], dict[str, Any]] = {}
        for slot_name in slot_names:
            month = item.get(slot_name) or {}
            try:
                key = (int(month.get("year")), int(month.get("month")))
            except (TypeError, ValueError):
                continue
            by_period.setdefault(key, month)
        for slot_name, period in targets:
            key = (int(period["year"]), int(period["month"]))
            item[slot_name] = by_period.get(key) or _empty_month(period)
        aligned.append(item)
    return aligned


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
    items = align_item_periods(items, calendar)
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
        self.chart_totals = {}
        self.new_member_tasks: dict[str, asyncio.Task] = {}
        self.new_member_retry: dict[str, datetime] = {}
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
        self.poonggo_live = PoonggoLiveService()
        self.independent_status = False
        self.status_fallback_after: dict[str, float] = {}
        self.status_verify_after: dict[str, float] = {}
        self.public_live_ids: set[str] | None = None
        self.public_live_observed_at = 0.0
        self.save_lock = asyncio.Lock()

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
            live_status = await retry(lambda: fetch_live_status(client, user_id), retries=2, delay=1, label=f"{user_id} live")
            try:
                station = await fetch_station(client, user_id)
            except Exception:
                # A profile/station failure must not hide a confirmed LIVE.
                station = {}
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
                await self._save_result_async(output, datetime.now(TIMEZONE))
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
                for item in align_members(cached.get("items") or [], members)
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
                    if self.independent_status:
                        continue
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
                        # The independent member lane bootstraps only this ID
                        # within five seconds, outside the normal cycle.
                        continue
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
                        if key in items_by_key and key not in bootstrap_keys and key not in quick_keys:
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
                    needs_recovery = key in self.recovery_required or (items_by_key[key].get("current_month") or {}).get("data_source") == "unavailable"
                    if (self.live_states.get(key, False) or needs_recovery) and now >= self.next_detail_at.get(key, now):
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
            await self._save_result_async(output, datetime.now(TIMEZONE))
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

    def _save_result(self, output, now):
        latest = get_cached_result() or {}
        self._prepare_result(output, latest, get_collector_members())
        save_result(output, now)

    async def _save_result_async(self, output, now):
        # Serialize dashboard writers while keeping HTTP/SSE on the event loop.
        async with self.save_lock:
            latest = await asyncio.to_thread(get_cached_result) or {}
            members = await asyncio.to_thread(get_collector_members)
            detached = deepcopy(output)
            # Live state must only be read on its owning event loop, never from
            # the DB thread while SSE mutates session dictionaries.
            self._prepare_result(detached, latest, members)
            write = asyncio.create_task(asyncio.to_thread(save_result, deepcopy(detached), now))
            try:
                await asyncio.shield(write)
            except asyncio.CancelledError:
                # A thread cannot be cancelled: retain ordering until it ends.
                await write
                raise

    def _prepare_result(self, output, latest, members):
        output_items = list(output.get("items") or [])
        ids = {str(item.get("user_id") or "").lower() for item in output_items}
        output["items"] = output_items + [
            item
            for item in latest.get("items") or []
            if str(item.get("user_id") or "").lower() not in ids
        ]
        # Re-read the source of truth at the last possible moment so a slow
        # source request cannot undo a concurrent admin move/delete.
        output["items"] = align_members(output["items"], members)
        current = output.get("current_period") or {}
        previous = output.get("previous_period") or {}
        older = output.get("older_period") or {}
        if current.get("year") and current.get("month"):
            if not previous.get("year") or not previous.get("month"):
                previous_year, previous_month = (
                    (int(current["year"]) - 1, 12)
                    if int(current["month"]) == 1
                    else (int(current["year"]), int(current["month"]) - 1)
                )
                previous = {"year": previous_year, "month": previous_month}
                output["previous_period"] = previous
            if not older.get("year") or not older.get("month"):
                older_year, older_month = (
                    (int(previous["year"]) - 1, 12)
                    if int(previous["month"]) == 1
                    else (int(previous["year"]), int(previous["month"]) - 1)
                )
                older = {"year": older_year, "month": older_month}
                output["older_period"] = older
            output["items"] = align_item_periods(
                output["items"],
                {"current": current, "previous": previous, "older": older},
            )
        for item in output["items"]:
            # A detail request may have started before a LIVE transition.
            item.update(self.poonggo_live.overlay_live_status(item))
        output["count"] = len(output["items"])
        # Cached/chart values can recover the month total, but never own a
        # calendar-day slot.  Only a broadcast-number session may do that.
        apply_totals(output, saved_totals(latest), include_daily=False)
        apply_totals(output, self.chart_totals, include_daily=False)
        poonggo_totals = {
            str(row["user_id"]): {
                "date": row["date"],
                "year": row["year"],
                "month": row["month"],
                "today": row["today"],
                "total": row["total"],
                "observed_at": row["observed_at"],
                "source": row.get("source") or "poonggo_sse",
                "daily_basis": row.get("daily_basis"),
                "fans": row.get("fans") or [],
                "previous_date": row.get("previous_date"),
                "previous_balloons": row.get("previous_balloons"),
                "previous_fans": row.get("previous_fans") or [],
            }
            for row in self.poonggo_live.snapshot()
        }
        apply_totals(output, poonggo_totals, authoritative=True)

    async def run_live_totals(self) -> None:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
            while True:
                delay = POLL_SECONDS
                try:
                    if acquire_collector_lease(self.holder, COLLECTOR_LEASE_SECONDS):
                        started = datetime.now(TIMEZONE)
                        self.chart_totals = await fetch_totals(client, started)
                        now = datetime.now(TIMEZONE)
                        output = get_cached_result()
                        if output:
                            changed = apply_totals(
                                output, self.chart_totals, include_daily=False
                            )
                            await self._save_result_async(output, now)
                            print(f"Live chart saved: requests=2 changed={changed} observed={now.isoformat()} elapsed={(now-started).total_seconds():.2f}s")
                        record_source_collection_result(True, now)
                except Exception as error:
                    # Honour source throttling without blocking detail work.
                    delay = max(POLL_SECONDS, getattr(error, "retry_after", None) or 90)
                    print(f"Live chart failed: {error}; retry in {delay}s")
                    record_source_collection_result(False, datetime.now(TIMEZONE))
                await asyncio.sleep(delay)

    async def run_status_forever(self) -> None:
        """Poll independently; publish each result before slower members finish."""
        semaphore = asyncio.Semaphore(STATUS_CONCURRENCY)
        async with httpx.AsyncClient(timeout=8, follow_redirects=True, headers=HEADERS) as client:
            async def check(member):
                async with semaphore:
                    uid = str(member["user_id"])
                    uid_key = uid.lower()
                    previous = self.poonggo_live.live_statuses.get(uid_key) or {}
                    roster_live = self.public_live_ids is not None and uid_key in self.public_live_ids
                    now_tick = asyncio.get_running_loop().time()

                    # One shared roster replaces hundreds of per-member calls
                    # for unchanged status.  Resolve a broadcast number for a
                    # newly LIVE member, and periodically verify an existing
                    # live session so a stop/start transition can change BNO.
                    if self.public_live_ids is not None:
                        if not roster_live and not previous.get("is_live"):
                            return member, {
                                "is_live": False,
                                "is_password": False,
                                "status_source": "soop_public_roster",
                            }
                        if roster_live and previous.get("is_live") and previous.get("broadcast_no"):
                            verify_after = self.status_verify_after.get(uid_key)
                            if verify_after is None:
                                self.status_verify_after[uid_key] = now_tick + 60
                                return member, {
                                    "is_live": True,
                                    "is_password": bool(previous.get("is_password_broadcast")),
                                    "broadcast_no": previous.get("broadcast_no"),
                                    "broadcast_title": previous.get("broadcast_title"),
                                    "viewer_count": previous.get("viewer_count"),
                                    "status_source": "soop_public_roster",
                                }
                            if now_tick < verify_after:
                                return member, {
                                    "is_live": True,
                                    "is_password": bool(previous.get("is_password_broadcast")),
                                    "broadcast_no": previous.get("broadcast_no"),
                                    "broadcast_title": previous.get("broadcast_title"),
                                    "viewer_count": previous.get("viewer_count"),
                                    "status_source": "soop_public_roster",
                                }
                            self.status_verify_after[uid_key] = now_tick + 300

                    connected = self.poonggo_live.connected_live_status(uid)
                    try:
                        async with asyncio.timeout(4):
                            # Do not wait for a station/profile fetch to publish LIVE.
                            status = await fetch_live_status(client, uid)
                        if (
                            roster_live
                            and not status.get("is_live")
                            and not status.get("is_password")
                        ):
                            # The platform-wide roster is the stronger current
                            # LIVE signal.  A periodic player/BNO verification
                            # can briefly return OFFLINE (notably for restricted
                            # streams); accepting that single negative made the
                            # badge disappear until the next roster round.
                            return member, {
                                "is_live": True,
                                "is_password": bool(previous.get("is_password_broadcast")),
                                "broadcast_no": previous.get("broadcast_no"),
                                "broadcast_title": previous.get("broadcast_title"),
                                "viewer_count": previous.get("viewer_count"),
                                "status_source": "soop_public_roster",
                            }
                        # A completed status response is authoritative.  In
                        # particular, an open donation SSE must never override
                        # an explicit OFFLINE result: Poonggo can keep ended
                        # broadcast sockets open.
                        return member, status
                    except Exception as error:
                        print(f"[{uid}] independent LIVE check failed: {type(error).__name__}: {error}")
                        # Limit fallback fan-out during a prolonged SOOP outage.
                        now_tick = asyncio.get_running_loop().time()
                        if now_tick >= self.status_fallback_after.get(uid, 0):
                            self.status_fallback_after[uid] = now_tick + 60
                            try:
                                async with asyncio.timeout(4):
                                    return member, await fetch_poonggo_live_status(client, uid)
                            except Exception as fallback_error:
                                print(f"[{uid}] fallback LIVE check failed: {type(fallback_error).__name__}: {fallback_error}")
                        if roster_live:
                            # The roster is current positive evidence even if
                            # the detail endpoints cannot resolve a BNO yet.
                            self.status_verify_after[uid_key] = now_tick + 60
                            return member, {
                                "is_live": True,
                                "is_password": False,
                                "broadcast_no": previous.get("broadcast_no"),
                                "broadcast_title": previous.get("broadcast_title"),
                                "viewer_count": previous.get("viewer_count"),
                                "status_source": "soop_public_roster",
                            }
                        # Only a recent donation event, not a merely open SSE
                        # socket, can bridge a round where both status sources
                        # are unavailable.
                        if connected:
                            return member, connected
                        return member, None

            while True:
                started = asyncio.get_running_loop().time()
                tasks = []
                try:
                    if acquire_collector_lease(self.holder, COLLECTOR_LEASE_SECONDS):
                        self._restore_state(datetime.now(TIMEZONE))
                        members = get_collector_members()
                        active = [m for m in members if not m.get("is_on_leave")]
                        try:
                            # The platform-wide response contains thousands of
                            # IDs and regularly takes more than eight seconds
                            # even though it succeeds.  It replaces up to 270
                            # per-member calls, so allow this one request time.
                            async with asyncio.timeout(22):
                                self.public_live_ids = set(await fetch_public_live_ids(client))
                            self.public_live_observed_at = asyncio.get_running_loop().time()
                        except Exception as roster_error:
                            age = asyncio.get_running_loop().time() - self.public_live_observed_at
                            if self.public_live_ids is None or age > 120:
                                self.public_live_ids = None
                            print(f"Public LIVE roster failed: {type(roster_error).__name__}: {roster_error}")
                        valid_ids = {str(m["user_id"]).lower() for m in active}
                        self.poonggo_live.live_statuses = {
                            k: v for k, v in self.poonggo_live.live_statuses.items() if k in valid_ids
                        }
                        tasks = [asyncio.create_task(check(m)) for m in active]
                        changed = False
                        for task in asyncio.as_completed(tasks):
                            member, status = await task
                            if status is None:
                                continue  # Unknown is not OFFLINE.
                            now = datetime.now(TIMEZONE)
                            uid = str(member["user_id"])
                            key = (member["crew_name"], uid)
                            was_live = self.live_states.get(key, False)
                            is_live = bool(status.get("is_live"))
                            viewers = str(status.get("viewer_count") or "")
                            payload = {
                                "user_id": uid, "is_live": is_live,
                                "is_password_broadcast": bool(status.get("is_password")),
                                "broadcast_no": str(status.get("broadcast_no") or "") if is_live else None,
                                "broadcast_title": status.get("broadcast_title") if is_live else None,
                                "viewer_count": int("".join(c for c in viewers if c.isdigit()) or "0") if is_live else None,
                                "status_source": status.get("status_source") or "soop_player",
                            }
                            previous = self.poonggo_live.live_statuses.get(uid.lower())
                            if previous and previous.get("last_live_end_at"):
                                payload["last_live_end_at"] = previous["last_live_end_at"]
                            if was_live and not is_live:
                                payload["last_live_end_at"] = now.isoformat()
                                self.next_detail_at[key] = now
                            transitioned = previous is None or any(previous.get(k) != v for k, v in payload.items())
                            # Renew confidence even when the broadcast is unchanged.
                            payload["status_observed_at"] = now.isoformat()
                            self.poonggo_live.publish_live_status(payload)
                            changed = True
                            if transitioned:
                                print(f"LIVE detected: user={uid} live={is_live} broadcast={payload['broadcast_no']} observed={now.isoformat()} poll_elapsed={asyncio.get_running_loop().time()-started:.2f}s")
                            self.live_states[key] = is_live
                            if was_live and not is_live:
                                self.recovery_required.add(key)
                        if changed:
                            output = get_cached_result()
                            if output:
                                await self._save_result_async(output, datetime.now(TIMEZONE))
                except Exception as error:
                    print(f"Independent LIVE poll failed: {error}")
                finally:
                    for task in tasks:
                        if not task.done():
                            task.cancel()
                    if tasks:
                        await asyncio.gather(*tasks, return_exceptions=True)
                await asyncio.sleep(max(1, STATUS_POLL_SECONDS - (asyncio.get_running_loop().time() - started)))

    async def run_forever(self) -> None:
        self.independent_status = True
        port = int(os.environ.get("PORT", os.environ.get("NAKSOO_LIVE_API_PORT", "8000")))
        api = uvicorn.Server(
            uvicorn.Config(
                create_live_app(self.poonggo_live),
                host="0.0.0.0",
                port=port,
                log_level=os.environ.get("NAKSOO_LIVE_API_LOG_LEVEL", "warning"),
                access_log=False,
            )
        )
        await asyncio.gather(
            self.run_detail_forever(),
            self.run_status_forever(),
            self.run_live_totals(),
            self.run_members_forever(),
            self.poonggo_live.run(),
            api.serve(),
        )

    async def _collect_new_member(self, member: dict[str, Any]) -> None:
        """Bootstrap exactly one newly registered member."""

        user_id = member["user_id"]
        key = user_id.lower()
        try:
            async with asyncio.timeout(60):
                now = datetime.now(TIMEZONE)
                periods = get_calendar_period(now)
                item: dict[str, Any] = {**member, "success": True, "is_live": False}
                async with httpx.AsyncClient(
                    headers=HEADERS,
                    timeout=10,
                    follow_redirects=True,
                ) as client:
                    # Three sequential detail requests, no donor-profile fanout.
                    for period_key, period in periods.items():
                        data = await retry(
                            lambda p=period: fetch_balloon(
                                client, user_id, p["year"], p["month"]
                            ),
                            retries=2,
                            delay=1,
                            label=f"{user_id} new member {period_key}",
                        )
                        if (
                            not is_poong_not_found_response(data)
                            and not is_month_data_available(data)
                        ):
                            raise ValueError("Incomplete new-member monthly data")
                        item[f"{period_key}_month"] = build_month_data(
                            data, period["year"], period["month"]
                        )
                        item[f"{period_key}_month"]["data_source"] = "detail"

                    try:
                        live = await fetch_live_status(client, user_id)
                        item.update(
                            is_live=live["is_live"],
                            is_password_broadcast=live.get("is_password"),
                            broadcast_no=live.get("broadcast_no"),
                            broadcast_title=live.get("broadcast_title"),
                            viewer_count=live.get("viewer_count"),
                        )
                    except Exception as error:
                        print(f"[{user_id}] new-member live status failed: {error}")

                collected_at = datetime.now(TIMEZONE)
                item["last_detail_collected_at"] = collected_at.isoformat()
                latest = get_cached_result() or {}
                latest["items"] = [
                    existing
                    for existing in latest.get("items") or []
                    if str(existing.get("user_id") or "").lower() != key
                ] + [item]
                await self._save_result_async(latest, collected_at)
                self.new_member_retry.pop(key, None)
                print(f"New member saved: {user_id}; monthly requests=3")
        except Exception as error:
            self.new_member_retry[key] = datetime.now(TIMEZONE) + timedelta(seconds=90)
            print(f"New member failed: {user_id}: {error}; retry in 90s")

    async def run_members_forever(self) -> None:
        """Publish moves/deletes and discover new IDs every five seconds."""

        try:
            while True:
                try:
                    self.new_member_tasks = {
                        key: task
                        for key, task in self.new_member_tasks.items()
                        if not task.done()
                    }
                    if acquire_collector_lease(self.holder, COLLECTOR_LEASE_SECONDS):
                        latest = get_cached_result()
                        if latest:
                            members = get_collector_members()
                            aligned = align_members(latest.get("items") or [], members)
                            if aligned != latest.get("items"):
                                latest["items"] = aligned
                                await self._save_result_async(latest, datetime.now(TIMEZONE))

                            known = {
                                str(item.get("user_id") or "").lower()
                                for item in aligned
                            }
                            now = datetime.now(TIMEZONE)
                            for member in members:
                                key = member["user_id"].lower()
                                retry_at = self.new_member_retry.get(key)
                                if len(self.new_member_tasks) >= 2:
                                    break
                                if (
                                    key not in known
                                    and key not in self.new_member_tasks
                                    and not member.get("is_on_leave")
                                    and (retry_at is None or now >= retry_at)
                                ):
                                    self.new_member_tasks[key] = asyncio.create_task(
                                        self._collect_new_member(member)
                                    )
                except Exception as error:
                    print(f"Membership sync failed: {error}")
                await asyncio.sleep(5)
        finally:
            for task in self.new_member_tasks.values():
                task.cancel()
            await asyncio.gather(
                *self.new_member_tasks.values(), return_exceptions=True
            )

    async def run_detail_forever(self) -> None:
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
