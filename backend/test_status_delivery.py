import asyncio
import unittest
import threading
from unittest.mock import patch
from datetime import datetime

from realtime_worker import RealtimeCollector
from live_totals import KST


class StatusDeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_database_save_does_not_block_loop_and_writes_are_serial(self):
        collector = RealtimeCollector()
        entered = threading.Event()
        release = threading.Event()
        writes = []

        def save(output, now):
            writes.append(output)
            entered.set()
            if not release.wait(2):
                raise AssertionError("Event loop could not release DB writer")

        with (patch("realtime_worker.get_cached_result", return_value={}),
              patch("realtime_worker.get_collector_members", return_value=[]),
              patch("realtime_worker.save_result", side_effect=save)):
            first = asyncio.create_task(collector._save_result_async({"items": []}, datetime.now(KST)))
            second = None
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 1))
                second = asyncio.create_task(collector._save_result_async({"items": []}, datetime.now(KST)))
                await asyncio.sleep(0.02)
                self.assertEqual(len(writes), 1)
                collector.poonggo_live.publish_live_status({"user_id": "test", "is_live": False})
                self.assertIn("test", collector.poonggo_live.live_statuses)
            finally:
                release.set()
                await first
                if second is not None:
                    await second
            self.assertEqual(len(writes), 2)

    def test_status_overlay_preserves_start_only_for_same_broadcast(self):
        service = RealtimeCollector().poonggo_live
        service.publish_live_status({"user_id": "iluvbin", "is_live": True, "broadcast_no": "new", "status_observed_at": datetime.now(KST).isoformat()})
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
                  patch("realtime_worker.fetch_poonggo_live_status", side_effect=TimeoutError("fallback slow")),
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

    async def test_connected_donation_stream_renews_live_when_status_sources_timeout(self):
        collector = RealtimeCollector()
        collector.state_restored = True
        old = "2026-01-01T00:00:00+09:00"
        collector.poonggo_live.publish_live_status({
            "user_id": "iluvbin", "is_live": True, "broadcast_no": "new",
            "status_observed_at": old,
        })
        collector.poonggo_live.states["iluvbin"] = {
            "user_id": "iluvbin", "broadcast_no": "new", "connected": True,
            "_last_sse_at": datetime.now(KST).timestamp(),
        }
        collector.poonggo_live.stream_metadata["iluvbin"] = {
            "user_id": "iluvbin", "broadcast_no": "new",
        }
        finished = asyncio.Event()

        async def sleep(_):
            finished.set()
            await asyncio.Event().wait()

        with (patch("realtime_worker.acquire_collector_lease", return_value=True),
              patch("realtime_worker.get_collector_members", return_value=[{"user_id": "iluvbin", "crew_name": "crew"}]),
              patch("realtime_worker.fetch_live_status", side_effect=TimeoutError("blocked")),
              patch("realtime_worker.fetch_poonggo_live_status", side_effect=TimeoutError("fallback blocked")) as fallback,
              patch("realtime_worker.get_cached_result", return_value={}),
              patch("realtime_worker.asyncio.sleep", side_effect=sleep)):
            task = asyncio.create_task(collector.run_status_forever())
            try:
                await asyncio.wait_for(finished.wait(), 2)
                status = collector.poonggo_live.live_statuses["iluvbin"]
                self.assertTrue(status["is_live"])
                self.assertEqual(status["broadcast_no"], "new")
                self.assertEqual(status["status_source"], "poonggo_sse_connection")
                self.assertGreater(status["status_observed_at"], old)
                fallback.assert_awaited_once()
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task

    async def test_connected_donation_stream_does_not_override_offline_status(self):
        collector = RealtimeCollector()
        collector.state_restored = True
        collector.poonggo_live.states["iluvbin"] = {
            "user_id": "iluvbin", "broadcast_no": "new", "connected": True,
            "_last_sse_at": datetime.now(KST).timestamp(),
        }
        collector.poonggo_live.stream_metadata["iluvbin"] = {
            "user_id": "iluvbin", "broadcast_no": "new",
        }
        finished = asyncio.Event()

        async def sleep(_):
            finished.set()
            await asyncio.Event().wait()

        with (patch("realtime_worker.acquire_collector_lease", return_value=True),
              patch("realtime_worker.get_collector_members", return_value=[{"user_id": "iluvbin", "crew_name": "crew"}]),
              patch("realtime_worker.fetch_live_status", return_value={"is_live": False}),
              patch("realtime_worker.get_cached_result", return_value={}),
              patch("realtime_worker.asyncio.sleep", side_effect=sleep)):
            task = asyncio.create_task(collector.run_status_forever())
            try:
                await asyncio.wait_for(finished.wait(), 2)
                self.assertFalse(collector.poonggo_live.live_statuses["iluvbin"]["is_live"])
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
        collector.poonggo_live.publish_live_status({"user_id": "iluvbin", "is_live": True, "broadcast_no": "new", "status_observed_at": datetime.now(KST).isoformat()})
        result = {"items": [{"user_id": "iluvbin", "crew_name": "crew", "is_live": False}]}
        with (patch("realtime_worker.get_cached_result", return_value={}),
              patch("realtime_worker.get_collector_members", return_value=[{"user_id": "iluvbin", "crew_name": "crew"}]),
              patch("realtime_worker.save_result") as save):
            collector._save_result(result, datetime.now(KST))
        member = save.call_args.args[0]["items"][0]
        self.assertTrue(member["is_live"])
        self.assertEqual(member["broadcast_no"], "new")
