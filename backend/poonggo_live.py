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
from datetime import datetime
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
RECONCILE_SECONDS = max(60, int(os.environ.get("NAKSOO_POONGGO_RECONCILE_SECONDS", "90")))
ROSTER_RECONCILE_SECONDS = max(
    300, int(os.environ.get("NAKSOO_POONGGO_ROSTER_RECONCILE_SECONDS", "7200"))
)
ROSTER_RECONCILE_DELAY = max(
    0.1, float(os.environ.get("NAKSOO_POONGGO_ROSTER_RECONCILE_DELAY", "0.5"))
)
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
) -> dict[str, Any]:
    now = (now or datetime.now(KST)).astimezone(KST)
    date = now.date().isoformat()
    daily_url = f"{POONGGO_BASE_URL}/station/{user_id}/daily"
    monthly_url = f"{POONGGO_BASE_URL}/station/{user_id}/monthly"
    daily, monthly = await asyncio.gather(
        client.get(daily_url, params={"date": date, "perPage": 100}),
        client.get(monthly_url, params={"date": f"{now.year}-{now.month:02d}-01"}),
    )
    daily.raise_for_status()
    monthly.raise_for_status()
    return {
        "user_id": user_id,
        "date": date,
        "year": now.year,
        "month": now.month,
        "today": parse_poonggo_total(daily.text, user_id),
        "total": parse_poonggo_total(monthly.text, user_id),
        "fans": parse_poonggo_daily_fans(daily.text, user_id),
        "observed_at": _iso_now(),
        "source": "poonggo_snapshot",
    }


class PoonggoLiveService:
    def __init__(self) -> None:
        self.states: dict[str, dict[str, Any]] = {}
        self.stream_tasks: dict[str, asyncio.Task] = {}
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
    ) -> None:
        user_id = str(metadata["user_id"]).lower()
        public_metadata = {key: value for key, value in metadata.items() if key != "semaphore"}
        async with self.lock:
            previous = self.states.get(user_id) or {}
            if (
                expected_revision is not None
                and int(previous.get("_event_revision") or 0) != expected_revision
            ):
                # A gift arrived while both HTML snapshots were in flight.
                # Keep the immediately applied event and let the next quiet
                # reconciliation establish the exact authoritative baseline.
                snapshot = {
                    **snapshot,
                    "today": max(int(snapshot.get("today") or 0), int(previous.get("today") or 0)),
                    "total": max(int(snapshot.get("total") or 0), int(previous.get("total") or 0)),
                    "fans": previous.get("fans") or snapshot.get("fans") or [],
                }
            next_state = {
                **previous,
                **public_metadata,
                **snapshot,
                "user_id": metadata["user_id"],
                "connected": bool(previous.get("connected")),
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
            current_date = now.date().isoformat()
            current_month = (now.year, now.month)
            stored_month = (int(state.get("year") or 0), int(state.get("month") or 0))
            if state.get("date") != current_date:
                state = {**state, "date": current_date, "today": 0, "fans": []}
            if stored_month != current_month:
                state = {**state, "year": now.year, "month": now.month, "total": 0}
            state = {
                **state,
                **public_metadata,
                "today": int(state.get("today") or 0) + amount,
                "total": int(state.get("total") or 0) + amount,
                "observed_at": _event_time(event.get("occurredAt") or event.get("occurred_at")),
                "source": "poonggo_sse",
                "connected": True,
                "_event_revision": int(state.get("_event_revision") or 0) + 1,
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
                        snapshot = await fetch_poonggo_snapshot(client, metadata["user_id"])
                    await self.apply_snapshot(metadata, snapshot, expected_revision=revision)
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    print(f"[{metadata['user_id']}] Poonggo snapshot failed: {error}")
                await asyncio.sleep(RECONCILE_SECONDS)

    async def _stream_member(self, metadata: dict[str, Any]) -> None:
        await asyncio.gather(self._consume_sse(metadata), self._reconcile(metadata))

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
                    "semaphore": semaphore,
                }

            for key, task in tuple(self.stream_tasks.items()):
                current = self.states.get(key) or {}
                wanted = desired.get(key)
                if wanted is None or str(current.get("broadcast_no") or "") not in {"", wanted["broadcast_no"]}:
                    task.cancel()
                    self.stream_tasks.pop(key, None)
                    if current:
                        current["connected"] = False
                        self._broadcast("status", current)

            for key, metadata in desired.items():
                task = self.stream_tasks.get(key)
                if task is None or task.done():
                    self.stream_tasks[key] = asyncio.create_task(self._stream_member(metadata))
            await asyncio.sleep(5)

    async def reconcile_roster_forever(self) -> None:
        """Slowly correct every member from Poonggo without delaying startup.

        Live members already have a 90-second exact snapshot lane.  This
        independent sweep covers offline/missed-live members at the requested
        two-hour cadence, one station at a time, so a stale Poong.today value
        cannot remain in today's ranking indefinitely.
        """

        await asyncio.sleep(5)
        while True:
            started = asyncio.get_running_loop().time()
            try:
                cached = get_cached_result() or {}
                live_ids = set(self.stream_tasks)
                members: dict[str, dict[str, Any]] = {}
                for item in cached.get("items") or []:
                    user_id = str(item.get("user_id") or "").strip()
                    if not user_id or item.get("is_on_leave"):
                        continue
                    key = user_id.lower()
                    if key in live_ids:
                        continue
                    members[key] = {
                        "user_id": user_id,
                        "crew_name": str(item.get("crew_name") or ""),
                        "nickname": str(item.get("nickname") or user_id),
                    }

                async with httpx.AsyncClient(timeout=12, follow_redirects=True) as client:
                    for metadata in members.values():
                        try:
                            snapshot = await fetch_poonggo_snapshot(client, metadata["user_id"])
                            await self.apply_snapshot(metadata, snapshot)
                        except asyncio.CancelledError:
                            raise
                        except Exception as error:
                            print(f"[{metadata['user_id']}] Poonggo roster snapshot failed: {error}")
                        await asyncio.sleep(ROSTER_RECONCILE_DELAY)
                print(f"Poonggo roster reconciliation complete: {len(members)} offline members.")
            except asyncio.CancelledError:
                raise
            except Exception as error:
                print(f"Poonggo roster reconciliation failed: {error}")

            elapsed = asyncio.get_running_loop().time() - started
            await asyncio.sleep(max(5, ROSTER_RECONCILE_SECONDS - elapsed))

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
        await asyncio.gather(
            self.sync_streams(),
            self.reconcile_roster_forever(),
            self.flush_forever(),
        )


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
