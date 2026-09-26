import unittest
from datetime import date

from realtime_db import (
    _index_session_days,
    _is_authoritative_live_source,
    _merge_daily_fans,
    _merge_monthly_fans,
    _merge_session_days,
    _realtime_session_rows,
    _should_keep_live_snapshot,
)


class RealtimeDatabaseSourcePriorityTests(unittest.TestCase):
    def test_monthly_donor_never_regresses_on_partial_response(self):
        previous = [
            {"user_id": "pontus1125", "nickname": "잉여", "balloons": 1000000}
        ]
        incoming = [
            {"user_id": "pontus1125", "nickname": "새닉네임", "balloons": 630000}
        ]
        merged = _merge_monthly_fans(previous, incoming)
        self.assertEqual(merged[0]["balloons"], 1000000)
        self.assertEqual(merged[0]["nickname"], "새닉네임")

    def test_monthly_donor_missing_from_partial_response_is_retained(self):
        previous = [
            {"user_id": "pontus1125", "nickname": "잉여", "balloons": 1000000}
        ]
        self.assertEqual(
            _merge_monthly_fans(previous, [])[0]["balloons"], 1000000
        )

    def test_live_sources_are_authoritative(self):
        self.assertTrue(_is_authoritative_live_source("poonggo_sse"))
        self.assertTrue(_is_authoritative_live_source("poonggo_live_final"))

    def test_detail_sources_are_not_authoritative(self):
        self.assertFalse(_is_authoritative_live_source("detail"))
        self.assertFalse(_is_authoritative_live_source("poonggo_monthly"))
        self.assertFalse(_is_authoritative_live_source(None))

    def test_equal_detail_total_cannot_replace_live_snapshot(self):
        self.assertTrue(
            _should_keep_live_snapshot(589788, 589788, "poonggo_live_final", "detail")
        )

    def test_newer_live_total_can_replace_live_snapshot(self):
        self.assertFalse(
            _should_keep_live_snapshot(589788, 590000, "poonggo_live_final", "poonggo_sse")
        )

    def test_broadcast_session_repairs_polluted_chart_day(self):
        polluted = [
            {"day": 22, "balloons": 111116},
            {"day": 23, "balloons": 111116},
        ]
        sessions = [
            {"reporting_date": date(2026, 9, 22), "today_balloons": 8},
            {"reporting_date": date(2026, 9, 23), "today_balloons": 111116},
        ]
        self.assertEqual(
            _merge_session_days(polluted, sessions),
            [
                {"day": 22, "balloons": 8},
                {"day": 23, "balloons": 111116},
            ],
        )

    def test_cross_month_session_is_indexed_by_broadcast_start_date(self):
        row = {
            "streamer_id": "test",
            "reporting_date": date(2026, 9, 30),
            # The monthly observation can already belong to October.
            "year": 2026,
            "month": 10,
            "today_balloons": 100,
        }
        indexed = _index_session_days([row])
        self.assertIn(("test", 2026, 9), indexed)
        self.assertNotIn(("test", 2026, 10), indexed)

    def test_unflushed_sse_overlay_wins_over_persisted_session(self):
        month = {
            "realtime_totals": {
                "source": "poonggo_sse",
                "date": "2026-09-23",
                "today": 111116,
                "previous_date": "2026-09-22",
                "previous_balloons": 8,
            }
        }
        persisted = [
            {"reporting_date": date(2026, 9, 23), "today_balloons": 100000}
        ]
        merged = _merge_session_days([], persisted)
        merged = _merge_session_days(merged, _realtime_session_rows(month))
        self.assertEqual(
            merged,
            [
                {"day": 22, "balloons": 8},
                {"day": 23, "balloons": 111116},
            ],
        )

    def test_session_donors_override_daily_fallback(self):
        fallback = [{
            "reporting_date": date(2026, 9, 23),
            "daily_fans": [{"user_id": "fallback", "balloons": 5}],
        }]
        session = [{
            "reporting_date": date(2026, 9, 23),
            "daily_fans": [{"user_id": "live", "balloons": 10}],
        }]
        merged = _merge_daily_fans([], fallback)
        merged = _merge_daily_fans(merged, session)
        self.assertEqual(merged[0]["fans"][0]["user_id"], "live")


if __name__ == "__main__":
    unittest.main()
