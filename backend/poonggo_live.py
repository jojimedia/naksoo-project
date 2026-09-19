"""Live Poonggo donation streams with an in-memory frontend relay.

The monthly collector remains the durable/fallback lane.  While a streamer is
live this module keeps one upstream SSE connection, updates an in-process hot
snapshot immediately, relays only the changed streamer to browsers, and
flushes accumulated values to PostgreSQL in small batches.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from collections import deque
from contextlib import suppress
from datetime import date, datetime
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from live_totals import KST
from realtime_db import (
    get_cached_result,
    load_live_totals,
    load_recent_donation_ids,
    persist_live_updates,
)


POONGGO_BASE_URL = "https://poonggo.com"
POONGGO_SSE_URL = "https://sse2.poonggo.com"
RECONCILE_SECONDS = max(60, int(os.environ.get("NAKSOO_POONGGO_RECONCILE_SECONDS", "60")))
FLUSH_SECONDS = max(1, int(os.environ.get("NAKSOO_LIVE_FLUSH_SECONDS", "2")))
FLUSH_EVENT_COUNT = max(1, int(os.environ.get("NAKSOO_LIVE_FLUSH_EVENT_COUNT", "20")))
MAX_SEEN_IDS = max(1_000, int(os.environ.get("NAKSOO_LIVE_SEEN_IDS", "10000")))

_BROADCAST_INFO = re.compile(
    r'broadcastInfo:\{streamerId:"(?P<user>[^"]+)".*?donationAmount:"(?P<amount>\d+)"',
    re.DOTALL,
)
_DONOR_LIST = re.compile(r"list:\[(?P<items>.*?)\],pagination:\{", re.DOTALL)
_DONOR = re.compile(
    r'\{donatorId:"(?P<id>(?:\\.|[^"])*)",donatorNickname:"(?P<nick>(?:\\.|[^"])*)",'
    r'totalAmount:"(?P<amount>\d+)"',
    re.DOTALL,
)
_LIVE_STATION = re.compile(
    r'streamer:\{streamNo:"(?P<stream>[^"]+)",streamerId:"(?P<user>[^"]+)"'
)
_LIVE_INFO = re.compile(
    r'liveInfo:\{[^}]*?startedAt:new Date\((?P<started>\d+)\)'
    r'[^}]*?donationAmount:"(?P<amount>\d+)"[^}]*?donationCount:"(?P<count>\d+)"',
    re.DOTALL,
)
_LIVE_DONATION = re.compile(
    r'\{id:"(?P<id>[^\"]+)",donatorId:"(?P<user>(?:\\.|[^\"])*)",'
    r'donatorNickname:"(?P<nick>(?:\\.|[^\"])*)",amount:"(?P<amount>\d+)"',
    re.DOTALL,
)


def parse_poonggo_total(html: str, user_id: str) -> int:
    """Extract only the requested station's summary, not sidebar rankings."""

    for match in _BROADCAST_INFO.finditer(html):
        if match.group("user").lower() == user_id.lower():
            return int(match.group("amount"))
    raise ValueError(f"Poonggo summary missing for {user_id}")


def _decode_js_string(value: str) -> str:
    try:
        return json.loads(f'"{value}"')
    except (json.JSONDecodeError, UnicodeDecodeError):
        return value.replace('\\"', '"').replace("\\\\", "\\")


def parse_poonggo_daily_fans(html: str, user_id: str) -> list[dict[str, Any]]:
    """Read Poonggo's daily donor ranking (the response allows 100 rows)."""

    station = next(
        (
            match
            for match in _BROADCAST_INFO.finditer(html)
            if match.group("user").lower() == user_id.lower()
        ),
        None,
    )
    block = _DONOR_LIST.search(html, station.end() if station else 0)
    if not block:
        return []
    fans = [
        {
            "user_id": _decode_js_string(match.group("id")),
            "nickname": _decode_js_string(match.group("nick")),
            "balloons": int(match.group("amount")),
        }
        for match in _DONOR.finditer(block.group("items"))
    ]
    fans.sort(key=lambda fan: fan["balloons"], reverse=True)
    return [{**fan, "rank": index + 1} for index, fan in enumerate(fans)]


def merge_fans_max(*groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge two observations without double counting the same donor."""

    merged: dict[str, dict[str, Any]] = {}
    for fans in groups:
        for fan in fans:
            key = str(fan.get("user_id") or fan.get("nickname") or "").lower()
            if not key:
                continue
            current = merged.get(key)
            if current is None or int(fan.get("balloons") or 0) > int(current.get("balloons") or 0):
                merged[key] = dict(fan)
    ordered = sorted(merged.values(), key=lambda fan: int(fan.get("balloons") or 0), reverse=True)
    return [{**fan, "rank": index + 1} for index, fan in enumerate(ordered)]


def parse_broadcast_start_date(value: Any) -> date | None:
    """Parse SOOP's authoritative broadStart value as a KST calendar date."""

    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=KST)
        return parsed.astimezone(KST).date()
    except ValueError:
        match = re.match(r"^(\d{4})[-/.](\d{2})[-/.](\d{2})", text)
        return date.fromisoformat("-".join(match.groups())) if match else None


def parse_poonggo_live_total(html: str, user_id: str, broadcast_no: str) -> tuple[int, date]:
    """Read the requested broadcast, never the station's calendar summary."""

    station = _LIVE_STATION.search(html)
    if not station or (station.group("user").lower(), station.group("stream")) != (
        user_id.lower(), str(broadcast_no)
    ):
        raise ValueError(f"Poonggo live broadcast mismatch for {user_id}/{broadcast_no}")
    live = _LIVE_INFO.search(html, station.end())
    if not live:
        raise ValueError(f"Poonggo live total unavailable for {user_id}/{broadcast_no}")
    started = datetime.fromtimestamp(int(live.group("started")) / 1000, KST).date()
    return int(live.group("amount")), started


def parse_poonggo_live_donations(
    html: str, user_id: str, broadcast_no: str
) -> tuple[list[dict[str, Any]], list[str], bool]:
    """Aggregate the broadcast's own donation list, never a calendar-day list."""

    station = _LIVE_STATION.search(html)
    if not station or (station.group("user").lower(), station.group("stream")) != (
        user_id.lower(), str(broadcast_no)
    ):
        raise ValueError(f"Poonggo live broadcast mismatch for {user_id}/{broadcast_no}")
    live = _LIVE_INFO.search(html, station.end())
    if not live:
        raise ValueError(f"Poonggo live donations unavailable for {user_id}/{broadcast_no}")
    opening = html.find("donations:[", live.end())
    if opening < 0:
        raise ValueError(f"Poonggo live donation list missing for {user_id}/{broadcast_no}")
    start = opening + len("donations:")
    depth, quoted, escaped = 0, False, False
    end = -1
    for index in range(start, len(html)):
        char = html[index]
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char == "[":
            depth += 1
        elif char == "]":
            depth -= 1
            if depth == 0:
                end = index
                break
    if end < 0:
        raise ValueError(f"Poonggo live donation list incomplete for {user_id}/{broadcast_no}")

    donations = list(_LIVE_DONATION.finditer(html[start + 1:end]))
    complete = len(donations) == int(live.group("count"))
    fans: dict[str, dict[str, Any]] = {}
    for donation in donations:
        donor_id = _decode_js_string(donation.group("user"))
        nickname = _decode_js_string(donation.group("nick"))
        key = (donor_id or nickname).lower()
        if not key:
            continue
        fan = fans.setdefault(key, {"user_id": donor_id, "nickname": nickname, "balloons": 0})
        fan["balloons"] += int(donation.group("amount"))
        fan["nickname"] = nickname
    ordered = sorted(fans.values(), key=lambda fan: fan["balloons"], reverse=True)
    return (
        [{**fan, "rank": index + 1} for index, fan in enumerate(ordered)],
        [donation.group("id") for donation in donations],
        complete,
    )


def _iso_now() -> str:
    return datetime.now(KST).isoformat()


def _event_time(value: Any) -> str:
    if isinstance(value, str) and value:
        return value
    return _iso_now()


async def fetch_poonggo_snapshot(
    client: httpx.AsyncClient,
    user_id: str,
    now: datetime | None = None,
    broadcast_start: Any = None,
    broadcast_no: str | None = None,
) -> dict[str, Any]:
    if not broadcast_no:
        raise ValueError("A SOOP broadcast number is required for a live snapshot")
    now = (now or datetime.now(KST)).astimezone(KST)
    live_url = f"{POONGGO_BASE_URL}/station/{user_id}/{broadcast_no}"
    monthly_url = f"{POONGGO_BASE_URL}/station/{user_id}/monthly"
    live, monthly = await asyncio.gather(
        client.get(live_url),
        client.get(monthly_url, params={"date": f"{now.year}-{now.month:02d}-01"}),
    )
    live.raise_for_status()
    monthly.raise_for_status()
    today, reporting_date = parse_poonggo_live_total(live.text, user_id, broadcast_no)
    fans, donation_ids, fans_complete = parse_poonggo_live_donations(
        live.text, user_id, broadcast_no
    )

    return {
        "user_id": user_id,
        "date": reporting_date.isoformat(),
        "display_date": now.date().isoformat(),
        "year": now.year,
        "month": now.month,
        "today": today,
        "total": parse_poonggo_total(monthly.text, user_id),
        "fans": fans,
        "_donation_ids": donation_ids,
        "_fans_complete": fans_complete,
        "broadcast_no": str(broadcast_no or ""),
        "counting_mode": "broadcast_live_v4",
        "finalized": False,
        "observed_at": _iso_now(),
        "source": "poonggo_live_snapshot",
    }


class PoonggoLiveService:
    def __init__(self) -> None:
        self.states: dict[str, dict[str, Any]] = {}
        self.stream_tasks: dict[str, asyncio.Task] = {}
        self.stream_metadata: dict[str, dict[str, Any]] = {}
        self.finalize_tasks: set[asyncio.Task] = set()
        self.subscribers: set[asyncio.Queue[str]] = set()
        self.pending_events: list[dict[str, Any]] = []
        self.dirty_ids: set[str] = set()
        self.seen_ids: set[str] = set()
        self.seen_order: deque[str] = deque()
        self.lock = asyncio.Lock()
        self.changed = asyncio.Event()
        self.started_at = _iso_now()

    def _remember_id(self, donation_id: str) -> bool:
        if not donation_id or donation_id in self.seen_ids:
            return False
        self.seen_ids.add(donation_id)
        self.seen_order.append(donation_id)
        while len(self.seen_order) > MAX_SEEN_IDS:
            old = self.seen_order.popleft()
            self.seen_ids.discard(old)
        return True

    async def restore(self) -> None:
        try:
            for row in load_live_totals():
                self.states[str(row["user_id"]).lower()] = dict(row)
            for donation_id in load_recent_donation_ids():
                self._remember_id(str(donation_id))
        except Exception as error:
            # PostgreSQL may still be starting with the container. The normal
            # flush retry and the first Poonggo snapshot repopulate this state.
            print(f"Poonggo live restore delayed: {error}")

    def snapshot(self) -> list[dict[str, Any]]:
        return [
            {key: value for key, value in state.items() if not key.startswith("_")}
            for state in self.states.values()
        ]

    async def subscribe(self):
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=100)
        self.subscribers.add(queue)
        try:
            yield f"event: snapshot\ndata: {json.dumps(self.snapshot(), ensure_ascii=False)}\n\n"
            while True:
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=15)
                    yield message
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            self.subscribers.discard(queue)

    def _broadcast(self, event: str, payload: Any) -> None:
        if isinstance(payload, dict):
            payload = {key: value for key, value in payload.items() if not key.startswith("_")}
        message = f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
        for queue in tuple(self.subscribers):
            if queue.full():
                with suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
            with suppress(asyncio.QueueFull):
                queue.put_nowait(message)

    async def apply_snapshot(
        self,
        metadata: dict[str, Any],
        snapshot: dict[str, Any],
        expected_revision: int | None = None,
        only_if_current_broadcast: bool = False,
    ) -> None:
        user_id = str(metadata["user_id"]).lower()
        public_metadata = {key: value for key, value in metadata.items() if key != "semaphore"}
        snapshot = dict(snapshot)
        donation_ids = snapshot.pop("_donation_ids", [])
        fans_complete = snapshot.pop("_fans_complete", False)
        async with self.lock:
            previous = self.states.get(user_id) or {}
            incoming_broadcast = str(
                snapshot.get("broadcast_no") or metadata.get("broadcast_no") or ""
            )
            same_broadcast = bool(
                incoming_broadcast
                and str(previous.get("broadcast_no") or "") == incoming_broadcast
            )
            if only_if_current_broadcast and not same_broadcast:
                return
            same_live_session = (
                same_broadcast
                and previous.get("counting_mode") == "broadcast_live_v4"
                and snapshot.get("counting_mode") == "broadcast_live_v4"
            )
            in_flight_event = (
                same_live_session
                and expected_revision is not None
                and int(previous.get("_event_revision") or 0) != expected_revision
            )
            recent_event = (
                same_live_session
                and float(previous.get("_last_sse_at") or 0) > datetime.now(KST).timestamp() - 20
            )
            if in_flight_event or (
                recent_event and int(snapshot.get("today") or 0) < int(previous.get("today") or 0)
            ):
                # An HTML response can briefly lag a newly received SSE gift.
                # Retry the exact broadcast baseline on the next reconciliation.
                snapshot = {
                    **snapshot,
                    "today": max(int(snapshot.get("today") or 0), int(previous.get("today") or 0)),
                    "total": max(int(snapshot.get("total") or 0), int(previous.get("total") or 0)),
                    "fans": merge_fans_max(snapshot.get("fans") or [], previous.get("fans") or []),
                    "source": (
                        "poonggo_live_final"
                        if snapshot.get("source") == "poonggo_live_final"
                        else "poonggo_sse"
                    ),
                }
            elif same_live_session and not fans_complete:
                snapshot["fans"] = merge_fans_max(snapshot.get("fans") or [], previous.get("fans") or [])
            for donation_id in donation_ids:
                self._remember_id(str(donation_id))
            next_state = {
                **previous,
                **public_metadata,
                **snapshot,
                "user_id": metadata["user_id"],
                "connected": bool(previous.get("connected")),
                "counting_mode": snapshot.get("counting_mode") or "broadcast_live_v4",
                "_event_revision": int(previous.get("_event_revision") or 0),
            }
            self.states[user_id] = next_state
            self.dirty_ids.add(user_id)
            self.changed.set()
        self._broadcast("total", next_state)

    async def apply_donation(self, metadata: dict[str, Any], event: dict[str, Any]) -> None:
        donation_id = str(
            event.get("donationId") or event.get("donation_id") or event.get("id") or ""
        )
        amount = int(event.get("amount") or 0)
        if amount <= 0:
            return
        public_metadata = {key: value for key, value in metadata.items() if key != "semaphore"}
        async with self.lock:
            if not self._remember_id(donation_id):
                return
            user_id = str(metadata["user_id"]).lower()
            now = datetime.now(KST)
            state = self.states.get(user_id) or {
                **public_metadata,
                "user_id": metadata["user_id"],
                "date": now.date().isoformat(),
                "year": now.year,
                "month": now.month,
                "today": 0,
                "total": 0,
            }
            current_month = (now.year, now.month)
            stored_month = (int(state.get("year") or 0), int(state.get("month") or 0))
            same_broadcast = bool(
                metadata.get("broadcast_no")
                and str(state.get("broadcast_no") or "") == str(metadata["broadcast_no"])
            )
            session_date = parse_broadcast_start_date(metadata.get("broadcast_start"))
            reporting_date = (
                str(state["date"])
                if same_broadcast and state.get("counting_mode") == "broadcast_live_v4"
                else (session_date or now.date()).isoformat()
            )
            if (
                state.get("date") != reporting_date
                or state.get("counting_mode") != "broadcast_live_v4"
                or not same_broadcast
            ):
                state = {
                    **state,
                    "date": reporting_date,
                    "today": 0,
                    "fans": [],
                    "counting_mode": "broadcast_live_v4",
                }
            if stored_month != current_month:
                state = {**state, "year": now.year, "month": now.month, "total": 0}
            state = {
                **state,
                **public_metadata,
                "today": int(state.get("today") or 0) + amount,
                "display_date": now.date().isoformat(),
                "total": int(state.get("total") or 0) + amount,
                "observed_at": _event_time(event.get("occurredAt") or event.get("occurred_at")),
                "source": "poonggo_sse",
                "connected": True,
                "counting_mode": "broadcast_live_v4",
                "finalized": False,
                "_event_revision": int(state.get("_event_revision") or 0) + 1,
                "_last_sse_at": now.timestamp(),
            }
            donor_id = str(
                event.get("donatorId")
                or event.get("donator_id")
                or event.get("donorId")
                or ""
            )
            donor_nickname = str(
                event.get("donatorNickname")
                or event.get("donator_nickname")
                or event.get("donorNickname")
                or donor_id
            )
            fans = [dict(fan) for fan in state.get("fans") or []]
            donor_key = donor_id.lower() if donor_id else donor_nickname.lower()
            matched = False
            for fan in fans:
                fan_key = str(fan.get("user_id") or fan.get("nickname") or "").lower()
                if fan_key == donor_key:
                    fan["balloons"] = int(fan.get("balloons") or 0) + amount
                    if donor_nickname:
                        fan["nickname"] = donor_nickname
                    matched = True
                    break
            if not matched and donor_key:
                fans.append(
                    {"user_id": donor_id, "nickname": donor_nickname, "balloons": amount}
                )
            fans.sort(key=lambda fan: int(fan.get("balloons") or 0), reverse=True)
            state["fans"] = [
                {**fan, "rank": index + 1} for index, fan in enumerate(fans)
            ]
            self.states[user_id] = state
            self.pending_events.append(
                {
                    "donation_id": donation_id,
                    "user_id": metadata["user_id"],
                    "broadcast_no": metadata.get("broadcast_no"),
                    "amount": amount,
                    "occurred_at": state["observed_at"],
                    "payload": event,
                }
            )
            self.dirty_ids.add(user_id)
            if len(self.pending_events) >= FLUSH_EVENT_COUNT:
                self.changed.set()
        self._broadcast("total", state)

    async def _mark_connection(self, user_id: str, connected: bool) -> None:
        key = user_id.lower()
        async with self.lock:
            state = self.states.get(key)
            if not state:
                return
            state["connected"] = connected
            state["observed_at"] = _iso_now()
            payload = dict(state)
        self._broadcast("status", payload)

    async def _consume_sse(self, metadata: dict[str, Any]) -> None:
        stream_no = metadata["broadcast_no"]
        timeout = httpx.Timeout(connect=10, read=None, write=10, pool=10)
        while True:
            try:
                async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
                    async with client.stream(
                        "GET",
                        f"{POONGGO_SSE_URL}/v1/streams/{stream_no}/donations",
                        headers={"Accept": "text/event-stream"},
                    ) as response:
                        response.raise_for_status()
                        await self._mark_connection(metadata["user_id"], True)
                        event_name = "message"
                        data_lines: list[str] = []
                        async for line in response.aiter_lines():
                            if not line:
                                if event_name == "donation" and data_lines:
                                    await self.apply_donation(metadata, json.loads("\n".join(data_lines)))
                                event_name, data_lines = "message", []
                            elif line.startswith("event:"):
                                event_name = line[6:].strip()
                            elif line.startswith("data:"):
                                data_lines.append(line[5:].strip())
            except asyncio.CancelledError:
                raise
            except Exception as error:
                await self._mark_connection(metadata["user_id"], False)
                print(f"[{metadata['user_id']}] Poonggo SSE reconnect: {error}")
                await asyncio.sleep(3)

    async def _reconcile(self, metadata: dict[str, Any]) -> None:
        semaphore = metadata["semaphore"]
        async with httpx.AsyncClient(timeout=12, follow_redirects=True) as client:
            while True:
                try:
                    key = str(metadata["user_id"]).lower()
                    async with self.lock:
                        revision = int((self.states.get(key) or {}).get("_event_revision") or 0)
                    async with semaphore:
                        snapshot = await fetch_poonggo_snapshot(
                            client,
                            metadata["user_id"],
                            broadcast_start=metadata.get("broadcast_start"),
                            broadcast_no=str(metadata.get("broadcast_no") or ""),
                        )
                    await self.apply_snapshot(metadata, snapshot, expected_revision=revision)
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    print(f"[{metadata['user_id']}] Poonggo snapshot failed: {error}")
                await asyncio.sleep(RECONCILE_SECONDS)

    async def _stream_member(self, metadata: dict[str, Any]) -> None:
        await asyncio.gather(self._consume_sse(metadata), self._reconcile(metadata))

    async def _finalize_stream(self, metadata: dict[str, Any]) -> None:
        """Keep the last broadcast value after SOOP reports that it ended."""

        user_id = str(metadata["user_id"]).lower()
        broadcast_no = str(metadata["broadcast_no"])
        await asyncio.sleep(3)
        async with httpx.AsyncClient(timeout=12, follow_redirects=True) as client:
            for attempt in range(2):
                try:
                    snapshot = await fetch_poonggo_snapshot(
                        client,
                        metadata["user_id"],
                        broadcast_start=metadata.get("broadcast_start"),
                        broadcast_no=broadcast_no,
                    )
                    snapshot["source"] = "poonggo_live_final"
                    await self.apply_snapshot(
                        metadata, snapshot, only_if_current_broadcast=True
                    )
                    break
                except Exception as error:
                    print(f"[{user_id}] final live snapshot attempt {attempt + 1} failed: {error}")
                    if attempt == 0:
                        await asyncio.sleep(3)

        async with self.lock:
            state = self.states.get(user_id)
            if not state or str(state.get("broadcast_no") or "") != broadcast_no:
                return
            state["finalized"] = True
            state["connected"] = False
            state["display_date"] = datetime.now(KST).date().isoformat()
            self.dirty_ids.add(user_id)
            self.changed.set()
            payload = dict(state)
        self._broadcast("total", payload)

    async def sync_streams(self) -> None:
        semaphore = asyncio.Semaphore(2)
        while True:
            try:
                cached = get_cached_result() or {}
            except Exception as error:
                print(f"Poonggo live roster delayed: {error}")
                await asyncio.sleep(5)
                continue
            desired: dict[str, dict[str, Any]] = {}
            for item in cached.get("items") or []:
                if not item.get("is_live") or not item.get("broadcast_no"):
                    continue
                user_id = str(item.get("user_id") or "")
                if not user_id:
                    continue
                desired[user_id.lower()] = {
                    "user_id": user_id,
                    "crew_name": str(item.get("crew_name") or ""),
                    "nickname": str(item.get("nickname") or user_id),
                    "broadcast_no": str(item["broadcast_no"]),
                    "broadcast_start": item.get("broadcast_start"),
                    "semaphore": semaphore,
                }

            for key, task in tuple(self.stream_tasks.items()):
                current = self.states.get(key) or {}
                wanted = desired.get(key)
                metadata = self.stream_metadata.get(key)
                if wanted is None or (metadata and metadata["broadcast_no"] != wanted["broadcast_no"]):
                    task.cancel()
                    self.stream_tasks.pop(key, None)
                    self.stream_metadata.pop(key, None)
                    if metadata:
                        final_task = asyncio.create_task(self._finalize_stream(metadata))
                        self.finalize_tasks.add(final_task)
                        final_task.add_done_callback(self.finalize_tasks.discard)
                    if current:
                        current["connected"] = False
                        self._broadcast("status", current)

            for key, metadata in desired.items():
                task = self.stream_tasks.get(key)
                if task is None or task.done():
                    self.stream_tasks[key] = asyncio.create_task(self._stream_member(metadata))
                    self.stream_metadata[key] = metadata
            await asyncio.sleep(5)

    async def flush_forever(self) -> None:
        while True:
            try:
                await asyncio.wait_for(self.changed.wait(), timeout=FLUSH_SECONDS)
            except asyncio.TimeoutError:
                pass
            await asyncio.sleep(FLUSH_SECONDS)
            async with self.lock:
                if not self.dirty_ids:
                    self.changed.clear()
                    continue
                updates = [dict(self.states[key]) for key in self.dirty_ids if key in self.states]
                events = self.pending_events
                self.dirty_ids = set()
                self.pending_events = []
                self.changed.clear()
            try:
                persist_live_updates(updates, events, datetime.now(KST))
            except Exception as error:
                print(f"Poonggo live flush failed: {error}")
                async with self.lock:
                    self.dirty_ids.update(str(row["user_id"]).lower() for row in updates)
                    self.pending_events = events + self.pending_events
                    self.changed.set()

    async def run(self) -> None:
        await self.restore()
        await asyncio.gather(self.sync_streams(), self.flush_forever())


def create_live_app(service: PoonggoLiveService) -> FastAPI:
    app = FastAPI(title="Naksoo live totals", docs_url=None, redoc_url=None)
    origins = [value.strip() for value in os.environ.get("NAKSOO_FRONTEND_ORIGINS", "*").split(",") if value.strip()]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=False,
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    @app.get("/live/snapshot")
    async def live_snapshot():
        return {"items": service.snapshot(), "generated_at": _iso_now()}

    @app.get("/live/events")
    async def live_events(request: Request):
        async def stream():
            async for message in service.subscribe():
                if await request.is_disconnected():
                    break
                yield message

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
        )

    @app.get("/health")
    async def health():
        return {
            "ok": True,
            "started_at": service.started_at,
            "live_streams": len(service.stream_tasks),
            "connected_streams": sum(1 for item in service.states.values() if item.get("connected")),
            "subscribers": len(service.subscribers),
        }

    return app
