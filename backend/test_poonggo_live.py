import unittest
from datetime import datetime
from unittest.mock import AsyncMock, patch

import httpx

from live_totals import KST, apply_totals
from poonggo_live import (
    PoonggoLiveService,
    fetch_poonggo_snapshot,
    parse_poonggo_daily_fans,
    parse_poonggo_live_donations,
    parse_poonggo_live_total,
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


def live_page(user_id: str, stream_no: str, amount: int, started_ms: int) -> str:
    return (
        '<script>sidebar:{donationAmount:"999999"},'
        f'streamer:{{streamNo:"{stream_no}",streamerId:"{user_id}",isLive:true}},'
        f'liveInfo:{{startedAt:new Date({started_ms}),endedAt:null,'
        f'donationAmount:"{amount}",donationCount:"0"}},donations:[]</script>'
    )


class PoonggoLiveTests(unittest.IsolatedAsyncioTestCase):
    def test_broadcast_donors_sum_to_live_total(self):
        html = (
            '<script>streamer:{streamNo:"297247895",streamerId:"dhtnqls1238",isLive:true}},'
            'liveInfo:{startedAt:new Date(1789824038000),donationAmount:"15618",donationCount:"3"},'
            'donations:[{id:"1",donatorId:"fan1",donatorNickname:"큰손",amount:"10000"},'
            '{id:"2",donatorId:"fan2",donatorNickname:"후원자",amount:"5618"},'
            '{id:"3",donatorId:"fan1",donatorNickname:"큰손",amount:"0"}]</script>'
        )
        fans, ids, complete = parse_poonggo_live_donations(html, "dhtnqls1238", "297247895")
        self.assertTrue(complete)
        self.assertEqual(ids, ["1", "2", "3"])
        self.assertEqual(sum(fan["balloons"] for fan in fans), 15618)
        self.assertEqual([fan["nickname"] for fan in fans], ["큰손", "후원자"])

    def test_parser_uses_station_summary_not_sidebar(self):
        self.assertEqual(parse_poonggo_total(page("03apple", 61222), "03apple"), 61222)
        self.assertEqual(parse_poonggo_daily_fans(page("03apple", 61222), "03apple")[0]["nickname"], "큰손")

    async def test_snapshot_fetches_broadcast_live_and_monthly_concurrently(self):
        calls = []

        def handle(request: httpx.Request):
            calls.append(request)
            if request.url.path.endswith("/monthly"):
                return httpx.Response(200, text=page("03apple", 186716))
            return httpx.Response(200, text=live_page("03apple", "123", 61222, 1789567200000))

        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await fetch_poonggo_snapshot(
                client, "03apple", datetime(2026, 9, 16, 15, tzinfo=KST),
                broadcast_no="123",
            )
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0].url.path, "/station/03apple/123")
        self.assertEqual(result["today"], 61222)
        self.assertEqual(result["total"], 186716)
        self.assertEqual(result["counting_mode"], "broadcast_live_v4")

    def test_live_parser_rejects_wrong_broadcast(self):
        html = live_page("dign1461", "real-soop-1", 97045, 1789567200000)
        self.assertEqual(parse_poonggo_live_total(html, "dign1461", "real-soop-1")[0], 97045)
        with self.assertRaises(ValueError):
            parse_poonggo_live_total(html, "dign1461", "real-soop-2")

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
                "display_date": now.date().isoformat(),
                "year": now.year,
                "month": now.month,
                "today": 100,
                "total": 1000,
                "fans": [{"rank": 1, "user_id": "fan1", "nickname": "큰손", "balloons": 100}],
                "observed_at": now.isoformat(),
                "source": "poonggo_live_snapshot",
                "counting_mode": "broadcast_live_v4",
                "broadcast_no": "123",
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
                "display_date": now.date().isoformat(),
                "year": now.year,
                "month": now.month,
                "today": 120,
                "total": 1020,
                "fans": [{"rank": 1, "user_id": "fan1", "nickname": "큰손", "balloons": 120}],
                "broadcast_no": "123",
                "observed_at": datetime.now(KST).isoformat(),
                "source": "poonggo_live_snapshot",
                "counting_mode": "broadcast_live_v4",
            },
        )
        self.assertEqual(service.states["03apple"]["today"], 150)
        self.assertEqual(service.states["03apple"]["total"], 1050)
        self.assertEqual(service.states["03apple"]["source"], "poonggo_sse")

    async def test_quiet_live_snapshot_corrects_inflated_value_and_donors(self):
        service = PoonggoLiveService()
        now = datetime.now(KST)
        metadata = {"user_id": "dhtnqls1238", "broadcast_no": "297247895"}
        base = {
            "date": now.date().isoformat(), "display_date": now.date().isoformat(),
            "year": now.year, "month": now.month, "broadcast_no": "297247895",
            "counting_mode": "broadcast_live_v4", "observed_at": now.isoformat(),
            "source": "poonggo_live_snapshot", "total": 50000,
        }
        await service.apply_snapshot(metadata, {
            **base, "today": 97045,
            "fans": [{"user_id": "stale", "nickname": "stale", "balloons": 97045}],
            "_fans_complete": True,
        })
        await service.apply_snapshot(metadata, {
            **base, "today": 15618, "total": 40000,
            "fans": [{"user_id": "fan", "nickname": "큰손", "balloons": 15618}],
            "_fans_complete": True,
        })
        state = service.states["dhtnqls1238"]
        self.assertEqual(state["today"], 15618)
        self.assertEqual(state["total"], 40000)
        self.assertEqual([fan["user_id"] for fan in state["fans"]], ["fan"])

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
                "counting_mode": "broadcast_live_v4",
                "display_date": now.date().isoformat(),
                "observed_at": now.isoformat(),
                "source": "poonggo_live_snapshot",
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
        self.assertEqual(service.states["dign1461"]["display_date"], now.date().isoformat())

    async def test_new_broadcast_same_day_uses_its_own_live_counter(self):
        service = PoonggoLiveService()
        now = datetime(2026, 9, 17, 20, tzinfo=KST)
        first = {
            "user_id": "dign1461", "crew_name": "광우상사", "nickname": "혜밍",
            "broadcast_no": "first", "broadcast_start": "2026-09-17 10:00:00",
        }
        second = {**first, "broadcast_no": "second", "broadcast_start": "2026-09-17 19:00:00"}
        await service.apply_snapshot(first, {
            "date": "2026-09-17", "year": 2026, "month": 9, "today": 19000,
            "total": 100000, "fans": [], "broadcast_no": "first",
            "counting_mode": "broadcast_live_v4", "observed_at": now.isoformat(),
            "source": "poonggo_live_snapshot",
        })
        await service.apply_snapshot(second, {
            "date": "2026-09-17", "year": 2026, "month": 9, "today": 3000,
            "total": 103000, "fans": [], "broadcast_no": "second",
            "counting_mode": "broadcast_live_v4", "observed_at": now.isoformat(),
            "source": "poonggo_live_snapshot",
        })
        state = service.states["dign1461"]
        self.assertEqual(state["today"], 3000)
        self.assertEqual(state["broadcast_no"], "second")

    async def test_broadcast_end_keeps_last_sse_value(self):
        service = PoonggoLiveService()
        now = datetime.now(KST)
        metadata = {
            "user_id": "dign1461", "crew_name": "광우상사", "nickname": "혜밍",
            "broadcast_no": "real-bno", "broadcast_start": now.isoformat(),
        }
        snapshot = {
            "date": now.date().isoformat(), "display_date": now.date().isoformat(),
            "year": now.year, "month": now.month, "today": 100, "total": 1000,
            "fans": [], "broadcast_no": "real-bno",
            "counting_mode": "broadcast_live_v4", "observed_at": now.isoformat(),
            "source": "poonggo_live_snapshot", "finalized": False,
        }
        await service.apply_snapshot(metadata, snapshot)
        await service.apply_donation(metadata, {
            "donation_id": "last-gift", "donator_id": "fan", "amount": 10,
            "occurred_at": now.isoformat(),
        })
        with patch("poonggo_live.fetch_poonggo_snapshot", new_callable=AsyncMock) as fetch:
            fetch.return_value = {**snapshot, "today": 105}
            await service._finalize_stream(metadata)
        state = service.states["dign1461"]
        self.assertEqual(state["today"], 110)
        self.assertTrue(state["finalized"])
        self.assertFalse(state["connected"])
        self.assertEqual(state["source"], "poonggo_live_final")

    async def test_old_broadcast_finalizer_cannot_replace_new_broadcast(self):
        service = PoonggoLiveService()
        now = datetime.now(KST)
        metadata = {"user_id": "dign1461", "broadcast_no": "new"}
        snapshot = {
            "date": now.date().isoformat(), "display_date": now.date().isoformat(),
            "year": now.year, "month": now.month, "today": 300,
            "total": 300, "fans": [], "broadcast_no": "new",
            "counting_mode": "broadcast_live_v4", "source": "poonggo_live_snapshot",
        }
        await service.apply_snapshot(metadata, snapshot)
        await service.apply_snapshot(
            {"user_id": "dign1461", "broadcast_no": "old"},
            {**snapshot, "broadcast_no": "old", "today": 1000},
            only_if_current_broadcast=True,
        )
        self.assertEqual(service.states["dign1461"]["today"], 300)

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
