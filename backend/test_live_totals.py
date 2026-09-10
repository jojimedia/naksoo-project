import asyncio
import copy
import unittest
from datetime import datetime
from unittest.mock import patch

import httpx

from live_totals import KST, apply_totals, chart_date, fetch_totals, saved_totals
from dashboard_cache import build_dashboard
from realtime_worker import RealtimeCollector


def sample():
    return {"current_period": {"year": 2026, "month": 9}, "previous_period": {"year": 2026, "month": 8},
            "items": [{"user_id": "test", "nickname": "Test", "crew_name": "Crew", "success": True,
                       "current_month": {"year": 2026, "month": 9, "total_balloons": 100,
                                         "daily_balloons": [{"day": 10, "balloons": 5}], "fans": [{"user_id": "fan", "balloons": 50}]}}]}


def snapshot(total=140, today=45):
    return {"test": {"year": 2026, "month": 9, "date": "2026-09-10", "total": total,
                     "today": today, "observed_at": "2026-09-10T11:00:00+09:00"}}


class LiveTotalsTests(unittest.IsolatedAsyncioTestCase):
    async def test_two_shared_requests_and_zero_is_valid(self):
        calls = []
        def handle(request):
            calls.append(request)
            rows = [{"i": "test", "b": 0}, {"i": "second", "b": 50}]
            return httpx.Response(200, json={"b": rows} if request.url.params["ctype"] == "month" else rows)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await fetch_totals(client, datetime(2026, 9, 10, 11, tzinfo=KST))
        self.assertEqual(len(calls), 2)
        self.assertEqual(result["test"]["today"], 0)
        self.assertEqual(result["second"]["total"], 50)

    async def test_throttling_no_immediate_retry(self):
        calls = []
        def handle(request):
            calls.append(request)
            return httpx.Response(429, headers={"Retry-After": "120"})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            with self.assertRaises(Exception) as caught:
                await fetch_totals(client, datetime.now(KST))
        self.assertEqual(caught.exception.retry_after, 120)
        self.assertEqual(len(calls), 1)

    def test_slow_detail_cannot_overwrite_published_chart(self):
        published = sample()
        apply_totals(published, snapshot())
        old_detail = sample()
        collector = RealtimeCollector()
        with patch("realtime_worker.get_cached_result", return_value=published), patch("realtime_worker.save_result") as save:
            collector._save_result(old_detail, datetime.now(KST))
        month = save.call_args.args[0]["items"][0]["current_month"]
        self.assertEqual(month["total_balloons"], 140)
        self.assertEqual(month["realtime_totals"]["today"], 45)
        self.assertEqual(month["daily_balloons"][-1]["balloons"], 45)
        self.assertEqual(month["fans"][0]["balloons"], 50)

    def test_month_boundary_does_not_add_previous_total_to_new_month(self):
        result = sample()
        before = copy.deepcopy(result)
        wrong = snapshot()
        wrong["test"]["month"] = 8
        apply_totals(result, wrong)
        self.assertEqual(result, before)
        self.assertEqual(chart_date(datetime(2026, 10, 1, 7, 59, tzinfo=KST)).isoformat(), "2026-09-30")
        self.assertEqual(chart_date(datetime(2026, 10, 1, 8, tzinfo=KST)).isoformat(), "2026-10-01")

    async def test_live_task_publishes_while_detail_is_blocked(self):
        collector = RealtimeCollector()
        published = asyncio.Event()
        detail_started = asyncio.Event()
        async def slow_detail():
            detail_started.set()
            await asyncio.Event().wait()
        async def chart(client, now):
            await detail_started.wait()
            return snapshot()
        def save(result, now):
            self.assertEqual(result["items"][0]["current_month"]["total_balloons"], 140)
            published.set()
        collector.run_detail_forever = slow_detail
        with patch("realtime_worker.acquire_collector_lease", return_value=True), patch("realtime_worker.fetch_totals", side_effect=chart), patch("realtime_worker.get_cached_result", side_effect=lambda: sample()), patch("realtime_worker.save_result", side_effect=save), patch("realtime_worker.record_source_collection_result"):
            task = asyncio.create_task(collector.run_forever())
            try:
                await asyncio.wait_for(published.wait(), timeout=1)
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task

    def test_dashboard_uses_chart_today_including_zero(self):
        for today in (45, 0):
            result = sample()
            apply_totals(result, snapshot(today=today))
            with patch("dashboard_cache.datetime") as clock:
                clock.now.return_value = datetime(2026, 9, 10, 11, tzinfo=KST)
                dashboard = build_dashboard(result)
            member = dashboard["crews"][0]["members"][0]
            self.assertEqual(member["display_day_balloons"], today)
            self.assertEqual(member["current_balloons"], 140)


if __name__ == "__main__":
    unittest.main()
