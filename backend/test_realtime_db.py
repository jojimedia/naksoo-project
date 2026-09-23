import unittest

from realtime_db import _is_authoritative_live_source, _should_keep_live_snapshot


class RealtimeDatabaseSourcePriorityTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
