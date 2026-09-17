import unittest
from datetime import datetime

import httpx

from live_totals import KST, apply_totals
from poonggo_live import (
    PoonggoLiveService,
    fetch_poonggo_snapshot,
    parse_poonggo_daily_fans,
    parse_poonggo_stream,
    parse_poonggo_total,
)


def page(user_id: str, amount: int, stream_no: str | None = None) -> str:
    return (
        '<script>sidebar:{donationAmount:"999999"},'
        + (
            f'streamNo:"{stream_no}",streamerId:"{user_id}",streamerNickname:"test",isLive:false}},'
            if stream_no
            else ""
        )
        + f'broadcastInfo:{{streamerId:"{user_id}",stationName:"test",'
        f'donationAmount:"{amount}",donationCount:"1"}},'
        'list:[{donatorId:"fan1",donatorNickname:"큰손",totalAmount:"100",'
        'donationCount:"1"}],pagination:{page:1,total:1}</script>'
    )


class PoonggoLiveTests(unittest.IsolatedAsyncioTestCase):
    def test_parser_uses_station_summary_not_sidebar(self):
        self.assertEqual(parse_poonggo_total(page("03apple", 61222), "03apple"), 61222)
        self.assertEqual(parse_poonggo_daily_fans(page("03apple", 61222), "03apple")[0]["nickname"], "큰손")

    async def test_snapshot_fetches_daily_and_monthly_concurrently(self):
        calls = []

        def handle(request: httpx.Request):
            calls.append(request)
            amount = 61222 if request.url.path.endswith("/daily") else 186716
            return httpx.Response(200, text=page("03apple", amount))

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await fetch_poonggo_snapshot(
                client, "03apple", datetime(2026, 9, 16, 15, tzinfo=KST)
            )
        self.assertEqual(len(calls), 2)
        self.assertEqual(result["today"], 61222)
        self.assertEqual(result["total"], 186716)
        self.assertEqual(result["fans"][0]["balloons"], 100)

    async def test_snapshot_keeps_calendar_days_separate_even_when_stream_number_repeats(self):
        def handle(request: httpx.Request):
            if request.url.path.endswith("/monthly"):
                return httpx.Response(200, text=page("tlsdbqls118", 110515))
            amount = 10 if request.url.params["date"] == "2026-09-17" else 110505
            return httpx.Response(200, text=page("tlsdbqls118", amount, "297161987"))

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await fetch_poonggo_snapshot(
                client, "tlsdbqls118", datetime(2026, 9, 17, 1, tzinfo=KST)
            )
        self.assertEqual(parse_poonggo_stream(page("tlsdbqls118", 10, "297161987"), "tlsdbqls118")["broadcast_no"], "297161987")
        self.assertEqual(result["today"], 10)
        self.assertEqual(result["fans"][0]["balloons"], 100)
        self.assertEqual(result["source"], "poonggo_calendar_snapshot")

    async def test_snapshot_joins_dates_only_from_authoritative_soop_start(self):
        def handle(request: httpx.Request):
            if request.url.path.endswith("/monthly"):
                return httpx.Response(200, text=page("dign1461", 200000))
            amount = 19115 if request.url.params["date"] == "2026-09-17" else 77930
            # Poonggo repeats this page-level number, but it is deliberately
            # ignored. The SOOP broadStart argument decides the session.
            return httpx.Response(200, text=page("dign1461", amount, "wrong-page-id"))

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            same_day = await fetch_poonggo_snapshot(
                client,
                "dign1461",
                datetime(2026, 9, 17, 1, tzinfo=KST),
                broadcast_start="2026-09-17 00:10:00",
                broadcast_no="real-soop-2",
            )
            across_midnight = await fetch_poonggo_snapshot(
                client,
                "dign1461",
                datetime(2026, 9, 17, 1, tzinfo=KST),
                broadcast_start="2026-09-16 23:10:00",
                broadcast_no="real-soop-1",
            )

        self.assertEqual(same_day["today"], 19115)
        self.assertEqual(same_day["date"], "2026-09-17")
        self.assertEqual(same_day["broadcast_no"], "real-soop-2")
        self.assertEqual(across_midnight["today"], 97045)
        self.assertEqual(across_midnight["date"], "2026-09-16")
        self.assertEqual(across_midnight["fans"][0]["balloons"], 200)

    async def test_donation_is_immediate_and_deduplicated(self):
        service = PoonggoLiveService()
        metadata = {
            "user_id": "03apple",
            "crew_name": "Crew",
            "nickname": "Soya",
            "broadcast_no": "123",
        }
        now = datetime.now(KST)
        await service.apply_snapshot(
            metadata,
            {
                "date": now.date().isoformat(),
                "year": now.year,
                "month": now.month,
                "today": 100,
                "total": 1000,
                "fans": [{"rank": 1, "user_id": "fan1", "nickname": "큰손", "balloons": 100}],
                "observed_at": now.isoformat(),
                "source": "poonggo_calendar_snapshot",
                "counting_mode": "calendar_day_v2",
            },
        )
        event = {
            "donation_id": "gift-1",
            "donator_id": "fan1",
            "donator_nickname": "큰손",
            "amount": 50,
            "occurred_at": "2026-09-16T15:00:01+09:00",
        }
        await service.apply_donation(metadata, event)
        await service.apply_donation(metadata, event)
        self.assertEqual(service.states["03apple"]["today"], 150)
        self.assertEqual(service.states["03apple"]["total"], 1050)
        self.assertEqual(service.states["03apple"]["fans"][0]["balloons"], 150)
        self.assertEqual(len(service.pending_events), 1)

        await service.apply_snapshot(
            metadata,
            {
                "date": now.date().isoformat(),
                "year": now.year,
                "month": now.month,
                "today": 120,
                "total": 1020,
                "fans": [{"rank": 1, "user_id": "fan1", "nickname": "큰손", "balloons": 120}],
                "broadcast_no": "123",
                "observed_at": datetime.now(KST).isoformat(),
                "source": "poonggo_snapshot",
                "counting_mode": "calendar_day_v2",
            },
        )
        self.assertEqual(service.states["03apple"]["today"], 150)
        self.assertEqual(service.states["03apple"]["total"], 1050)
        self.assertEqual(service.states["03apple"]["source"], "poonggo_sse")

    async def test_same_real_broadcast_keeps_start_date_at_midnight(self):
        service = PoonggoLiveService()
        now = datetime.now(KST)
        metadata = {
            "user_id": "dign1461",
            "crew_name": "광우상사",
            "nickname": "혜밍",
            "broadcast_no": "297165045",
            "broadcast_start": "2026-09-16 23:10:00",
        }
        await service.apply_snapshot(
            metadata,
            {
                "date": "2026-09-16",
                "year": now.year,
                "month": now.month,
                "today": 77930,
                "total": 77930,
                "fans": [],
                "broadcast_no": "297165045",
                "counting_mode": "broadcast_session_v3",
                "observed_at": now.isoformat(),
                "source": "poonggo_calendar_snapshot",
            },
        )
        await service.apply_donation(
            metadata,
            {
                "donation_id": "after-midnight",
                "donator_id": "fan",
                "donator_nickname": "후원자",
                "amount": 10,
                "occurred_at": now.isoformat(),
            },
        )
        self.assertEqual(service.states["dign1461"]["date"], "2026-09-16")
        self.assertEqual(service.states["dign1461"]["today"], 77940)

    async def test_new_broadcast_same_day_subtracts_previous_session(self):
        service = PoonggoLiveService()
        now = datetime(2026, 9, 17, 20, tzinfo=KST)
        first = {
            "user_id": "dign1461",
            "crew_name": "광우상사",
            "nickname": "혜밍",
            "broadcast_no": "first",
            "broadcast_start": "2026-09-17 10:00:00",
        }
        second = {**first, "broadcast_no": "second", "broadcast_start": "2026-09-17 19:00:00"}
        await service.apply_snapshot(first, {
            "date": "2026-09-17", "year": 2026, "month": 9,
            "today": 19000, "total": 100000, "fans": [],
            "broadcast_no": "first", "counting_mode": "broadcast_session_v3",
            "observed_at": now.isoformat(), "source": "poonggo_session_snapshot",
        })
        await service.apply_snapshot(second, {
            "date": "2026-09-17", "year": 2026, "month": 9,
            "today": 22000, "total": 103000, "fans": [],
            "broadcast_no": "second", "counting_mode": "broadcast_session_v3",
            "observed_at": now.isoformat(), "source": "poonggo_session_snapshot",
        })
        state = service.states["dign1461"]
        self.assertEqual(state["today"], 3000)
        self.assertEqual(state["session_offset"], 19000)

    def test_poonggo_total_remains_authoritative_over_poong_today(self):
        result = {
            "items": [{
                "user_id": "03apple",
                "current_month": {
                    "year": 2026,
                    "month": 9,
                    "total_balloons": 186716,
                    "daily_balloons": [],
                    "realtime_totals": {
                        "date": "2026-09-16",
                        "today": 61222,
                        "total": 186716,
                        "source": "poonggo_snapshot",
                        "observed_at": "2026-09-16T15:00:00+09:00",
                    },
                },
            }]
        }
        apply_totals(result, {"03apple": {
            "date": "2026-09-16", "year": 2026, "month": 9,
            "today": 26510, "total": 186616,
            "source": "poong_today_chart",
            "observed_at": "2026-09-16T15:01:00+09:00",
        }})
        month = result["items"][0]["current_month"]
        self.assertEqual(month["total_balloons"], 186716)
        self.assertEqual(month["realtime_totals"]["today"], 61222)
if __name__ == "__main__":
    unittest.main()
