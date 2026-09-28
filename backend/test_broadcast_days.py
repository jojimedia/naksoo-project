import asyncio
import json
import unittest
from datetime import date, datetime, timedelta
from unittest.mock import MagicMock, patch

from broadcast_days import aggregate_days
from live_totals import KST
from poonggo_live import PoonggoLiveService
from realtime_db import _merge_daily_fans, _realtime_session_rows, persist_live_updates


def session(bno, count, day="2026-09-27"):
    return {"user_id": "qor0919", "broadcast_no": bno, "date": day,
            "year": 2026, "month": 9, "today": count, "total": 5000,
            "fans": [{"user_id": "fan", "nickname": "후원자", "balloons": count}],
            "counting_mode": "broadcast_live_v4", "source": "poonggo_live_snapshot",
            "observed_at": datetime.now(KST).isoformat(), "_fans_complete": True}


class BroadcastDayTests(unittest.IsolatedAsyncioTestCase):
    async def test_two_broadcasts_same_day_sum_donors_and_counts_not_observations(self):
        service = PoonggoLiveService()
        queue = asyncio.Queue()
        service.subscribers.add(queue)
        for row in (session("a", 100), session("a", 130), session("b", 200)):
            await service.apply_snapshot({"user_id": row["user_id"], "broadcast_no": row["broadcast_no"]}, row)
        view = service.snapshot()[0]
        self.assertEqual(view["today"], 330)
        self.assertEqual(view["fans"][0]["balloons"], 330)
        self.assertEqual(service.states["qor0919"]["today"], 200)
        self.assertEqual(len(service.sessions), 2)
        while not queue.empty():
            event = queue.get_nowait()
        self.assertEqual(json.loads(event.split("data: ")[1])["today"], 330)

    async def test_midnight_and_month_boundary_do_not_move_start_day(self):
        service = PoonggoLiveService()
        row = session("a", 100, "2026-08-31")
        metadata = {"user_id": "qor0919", "broadcast_no": "a"}
        await service.apply_snapshot(metadata, row)
        await service.apply_donation(metadata, {"id": "gift", "amount": 30, "donatorId": "fan"})
        self.assertEqual(service.snapshot()[0]["date"], "2026-08-31")
        await service.apply_snapshot(metadata, {**row, "date": "2026-09-01", "today": 130})
        self.assertEqual(service.snapshot()[0]["date"], "2026-08-31")

    async def test_late_final_updates_old_session_without_replacing_new(self):
        service = PoonggoLiveService()
        for row in (session("a", 100), session("b", 200)):
            await service.apply_snapshot({"user_id": "qor0919", "broadcast_no": row["broadcast_no"]}, row)
        await service.apply_snapshot({"user_id": "qor0919", "broadcast_no": "a"}, session("a", 150), only_if_current_broadcast=True)
        self.assertEqual(service.states["qor0919"]["broadcast_no"], "b")
        self.assertEqual(service.snapshot()[0]["today"], 350)

    async def test_restart_restores_all_sessions_without_counting_current_twice(self):
        latest = session("b", 200)
        latest["_sessions"] = [session("a", 130), session("b", 200)]
        service = PoonggoLiveService()
        with patch("poonggo_live.load_live_totals", return_value=[latest]), patch("poonggo_live.load_recent_donation_ids", return_value=[]):
            await service.restore()
        self.assertEqual(service.snapshot()[0]["today"], 330)

    async def test_yesterday_contains_all_start_day_sessions(self):
        service = PoonggoLiveService()
        today = datetime.now(KST).date()
        for row in (session("a", 100, (today-timedelta(days=1)).isoformat()), session("b", 200, (today-timedelta(days=1)).isoformat()), session("c", 10, today.isoformat())):
            await service.apply_snapshot({"user_id": "qor0919", "broadcast_no": row["broadcast_no"]}, row)
        view = service.snapshot()[0]
        self.assertEqual((view["today"], view["previous_balloons"]), (10, 300))
        self.assertEqual(view["previous_fans"][0]["balloons"], 300)

    async def test_130_total_does_not_retain_1425_donor(self):
        service = PoonggoLiveService()
        metadata = {"user_id": "qor0919", "broadcast_no": "a"}
        await service.apply_snapshot(metadata, session("a", 1425))
        await service.apply_snapshot(metadata, {**session("a", 130), "fans": [], "_fans_complete": False})
        self.assertEqual(service.snapshot()[0]["today"], 130)
        self.assertEqual(service.snapshot()[0]["fans"], [])

    def test_empty_authoritative_fans_clear_legacy_daily_fallback(self):
        merged = _merge_daily_fans([{"day": 27, "fans": [{"balloons": 1425}]}], [{"reporting_date": date(2026, 9, 27), "daily_fans": []}])
        self.assertEqual(merged, [{"day": 27, "fans": []}])

    def test_database_aggregation_replaces_same_id_and_sums_distinct_ids(self):
        rows = [{"streamer_id": "qor0919", "broadcast_no": bno, "reporting_date": date(2026, 9, 27), "today_balloons": count, "daily_fans": []} for bno, count in (("a", 100), ("a", 130), ("b", 200))]
        self.assertEqual(aggregate_days(rows)[0]["today_balloons"], 330)

    def test_legacy_single_session_overlay_cannot_replace_day_sum(self):
        self.assertEqual(_realtime_session_rows({"realtime_totals": {"source": "poonggo_sse", "date": "2026-09-27", "today": 130}}), [])

    def test_flush_writes_raw_sessions_not_day_sum_and_archives_do_not_replace_hot_row(self):
        conn = MagicMock()
        with patch("realtime_db.connect") as connect:
            connect.return_value.__enter__.return_value = conn
            persist_live_updates([{**session("a", 130), "_session_only": True}, session("b", 200)], [], datetime.now(KST))
        statements = [(call.args[0], call.args[1]) for call in conn.execute.call_args_list]
        sessions = [params for sql, params in statements if "INSERT INTO streamer_live_sessions" in sql]
        self.assertEqual([params[8] for params in sessions], [130, 200])
        hot = [params for sql, params in statements if "INSERT INTO streamer_live_totals" in sql]
        self.assertEqual(len(hot), 1)
        self.assertEqual(hot[0][3], "b")
        for sql, params in statements:
            self.assertEqual(sql.count("%s"), len(params))
        self.assertTrue(any("SUM(today_balloons)" in sql for sql, _ in statements))
