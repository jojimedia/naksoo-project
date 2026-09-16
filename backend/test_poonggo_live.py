import unittest
from datetime import datetime

import httpx

from live_totals import KST, apply_totals
from poonggo_live import (
    PoonggoLiveService,
    fetch_poonggo_snapshot,
    parse_poonggo_daily_fans,
    parse_poonggo_total,
)


def page(user_id: str, amount: int) -> str:
    return (
        '<script>sidebar:{donationAmount:"999999"},'
        f'broadcastInfo:{{streamerId:"{user_id}",stationName:"test",'
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

    async def test_donation_is_immediate_and_deduplicated(self):
        service = PoonggoLiveService()
        metadata = {
            "user_id": "03apple",
            "crew_name": "Crew",
            "nickname": "Soya",
            "broadcast_no": "123",
        }
        await service.apply_snapshot(
            metadata,
            {
                "date": "2026-09-16",
                "year": 2026,
                "month": 9,
                "today": 100,
                "total": 1000,
                "fans": [{"rank": 1, "user_id": "fan1", "nickname": "큰손", "balloons": 100}],
                "observed_at": "2026-09-16T15:00:00+09:00",
                "source": "poonggo_snapshot",
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
