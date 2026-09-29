import asyncio
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

import httpx
from main import fetch_poonggo_live_status
from live_totals import KST
from live_status_freshness import display_status
from realtime_worker import RealtimeCollector


class FreshnessTests(unittest.IsolatedAsyncioTestCase):
    def test_expired_live_is_unknown_not_broadcast_end(self):
        now = datetime.now(KST)
        for seconds, expected in ((0, True), (120, True), (121, False)):
            row = {"user_id": "test", "is_live": True, "broadcast_no": "b", "status_observed_at": (now-timedelta(seconds=seconds)).isoformat()}
            result = display_status(row, now)
            self.assertEqual(result["is_live"], expected)
            self.assertEqual(result["status_stale"], not expected)
            self.assertNotIn("last_live_end_at", result)
        self.assertFalse(display_status({"is_live": True})["is_live"])

    def test_stale_badge_does_not_stop_donation_collection(self):
        service = RealtimeCollector().poonggo_live
        row = {"user_id": "test", "is_live": True, "broadcast_no": "b", "today": 100, "fans": [{"balloons": 100}], "status_observed_at": "2026-01-01T00:00:00+09:00"}
        service.publish_live_status(row)
        self.assertFalse(service.overlay_live_status(row)["is_live"])
        self.assertTrue(service.overlay_live_status(row, for_collection=True)["is_live"])
        self.assertEqual(service.overlay_live_status(row)["today"], 100)

    async def test_fallback_distinguishes_offline_live_and_missing_markup(self):
        for body, expected in (( 'streamer:{streamNo:"old",streamerId:"test",isLive:false}', False), ('streamer:{streamNo:"new",streamerId:"test",isLive:true}', True), ('error page', None)):
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200, text=body))) as client:
                if expected is None:
                    with self.assertRaises(ValueError):
                        await fetch_poonggo_live_status(client, "test")
                else:
                    result = await fetch_poonggo_live_status(client, "test")
                    self.assertEqual(result["is_live"], expected)

    async def test_primary_failure_fallback_confirms_end(self):
        collector = RealtimeCollector()
        collector.state_restored = True
        collector.live_states[("crew", "test")] = True
        queue = asyncio.Queue()
        collector.poonggo_live.subscribers.add(queue)
        with (patch("realtime_worker.acquire_collector_lease", return_value=True),
              patch("realtime_worker.get_collector_members", return_value=[{"user_id": "test", "crew_name": "crew"}]),
              patch("realtime_worker.fetch_live_status", side_effect=TimeoutError()),
              patch("realtime_worker.fetch_poonggo_live_status", return_value={"is_live": False, "status_source": "poonggo_station"}),
              patch("realtime_worker.get_cached_result", return_value={})):
            task = asyncio.create_task(collector.run_status_forever())
            try:
                await asyncio.wait_for(queue.get(), 2)
                self.assertFalse(collector.live_states[("crew", "test")])
                self.assertIn(("crew", "test"), collector.recovery_required)
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task

    async def test_unchanged_live_renews_confirmation(self):
        collector = RealtimeCollector()
        collector.state_restored = True
        old = (datetime.now(KST)-timedelta(seconds=90)).isoformat()
        collector.poonggo_live.publish_live_status({"user_id": "test", "is_live": True, "broadcast_no": "b", "broadcast_title": None, "viewer_count": 0, "is_password_broadcast": False, "status_source": "soop_player", "status_observed_at": old})
        queue = asyncio.Queue()
        collector.poonggo_live.subscribers.add(queue)
        with (patch("realtime_worker.acquire_collector_lease", return_value=True),
              patch("realtime_worker.get_collector_members", return_value=[{"user_id": "test", "crew_name": "crew"}]),
              patch("realtime_worker.fetch_live_status", return_value={"is_live": True, "broadcast_no": "b"}),
              patch("realtime_worker.get_cached_result", return_value={})):
            task = asyncio.create_task(collector.run_status_forever())
            try:
                await asyncio.wait_for(queue.get(), 2)
                self.assertGreater(collector.poonggo_live.live_statuses["test"]["status_observed_at"], old)
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
