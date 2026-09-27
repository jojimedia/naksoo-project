import asyncio
import unittest
from unittest.mock import patch
from datetime import datetime

from realtime_worker import RealtimeCollector
from live_totals import KST


class StatusDeliveryTests(unittest.IsolatedAsyncioTestCase):
    def test_status_overlay_preserves_start_only_for_same_broadcast(self):
        service = RealtimeCollector().poonggo_live
        service.publish_live_status({"user_id": "iluvbin", "is_live": True, "broadcast_no": "new"})
        item = {"user_id": "iluvbin", "broadcast_no": "new", "broadcast_start": "2026-09-26T23:00:00+09:00"}
        self.assertEqual(service.overlay_live_status(item)["broadcast_start"], item["broadcast_start"])
        self.assertIsNone(service.overlay_live_status({**item, "broadcast_no": "old"})["broadcast_start"])
        service.publish_live_status({"user_id": "iluvbin", "is_live": False, "broadcast_no": None})
        self.assertIsNone(service.overlay_live_status(item)["broadcast_start"])

    async def test_failed_check_keeps_previous_live_and_offline_check_publishes_end(self):
        for fail in (True, False):
            collector = RealtimeCollector()
            collector.state_restored = True
            collector.live_states[("crew", "iluvbin")] = True
            collector.poonggo_live.publish_live_status({"user_id": "iluvbin", "is_live": True, "broadcast_no": "old"})
            finished = asyncio.Event()
            async def status(client, uid):
                if fail:
                    raise TimeoutError("upstream slow")
                return {"is_live": False}
            async def sleep(_):
                finished.set()
                await asyncio.Event().wait()
            with (patch("realtime_worker.acquire_collector_lease", return_value=True),
                  patch("realtime_worker.get_collector_members", return_value=[{"user_id": "iluvbin", "crew_name": "crew"}]),
                  patch("realtime_worker.fetch_live_status", side_effect=status),
                  patch("realtime_worker.get_cached_result", return_value={}),
                  patch("realtime_worker.asyncio.sleep", side_effect=sleep)):
                task = asyncio.create_task(collector.run_status_forever())
                try:
                    await asyncio.wait_for(finished.wait(), 2)
                    self.assertEqual(collector.poonggo_live.live_statuses["iluvbin"]["is_live"], fail)
                    self.assertEqual(("crew", "iluvbin") in collector.recovery_required, not fail)
                finally:
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task

    async def test_fast_member_is_published_while_other_member_is_blocked(self):
        collector = RealtimeCollector()
        collector.state_restored = True
        queue = asyncio.Queue()
        collector.poonggo_live.subscribers.add(queue)
        members = [{"user_id": uid, "crew_name": "crew"} for uid in ("slow", "iluvbin")]

        async def status(client, uid):
            if uid == "slow":
                await asyncio.Event().wait()
            return {"is_live": True, "broadcast_no": "new", "viewer_count": "1,234"}

        with (patch("realtime_worker.acquire_collector_lease", return_value=True),
              patch("realtime_worker.get_collector_members", return_value=members),
              patch("realtime_worker.fetch_live_status", side_effect=status),
              patch.object(collector, "_save_result") as save):
            task = asyncio.create_task(collector.run_status_forever())
            try:
                event = await asyncio.wait_for(queue.get(), 2)
                self.assertIn("event: live_status", event)
                self.assertIn("iluvbin", event)
                self.assertTrue(collector.poonggo_live.live_statuses["iluvbin"]["is_live"])
                save.assert_not_called()
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task

    async def test_reconnect_replays_status_without_donation_baseline(self):
        service = RealtimeCollector().poonggo_live
        service.publish_live_status({"user_id": "iluvbin", "is_live": True, "broadcast_no": "new"})
        stream = service.subscribe()
        try:
            self.assertIn("event: snapshot", await anext(stream))
            status = await anext(stream)
            self.assertIn("event: live_status_snapshot", status)
            self.assertIn("iluvbin", status)
        finally:
            await stream.aclose()

    def test_slow_detail_save_cannot_undo_new_live_status(self):
        collector = RealtimeCollector()
        collector.poonggo_live.publish_live_status({"user_id": "iluvbin", "is_live": True, "broadcast_no": "new"})
        result = {"items": [{"user_id": "iluvbin", "crew_name": "crew", "is_live": False}]}
        with (patch("realtime_worker.get_cached_result", return_value={}),
              patch("realtime_worker.get_collector_members", return_value=[{"user_id": "iluvbin", "crew_name": "crew"}]),
              patch("realtime_worker.save_result") as save):
            collector._save_result(result, datetime.now(KST))
        member = save.call_args.args[0]["items"][0]
        self.assertTrue(member["is_live"])
        self.assertEqual(member["broadcast_no"], "new")
