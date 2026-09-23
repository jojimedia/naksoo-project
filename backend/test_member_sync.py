import unittest

from member_sync import align_members


class MemberSyncTests(unittest.TestCase):
    def test_transfer_preserves_stats_and_applies_new_crew(self):
        items = [
            {
                "user_id": "DHTNQLS1238",
                "crew_name": "FA",
                "nickname": "old nickname",
                "current_month": {"total_balloons": 1234},
            }
        ]
        members = [
            {
                "user_id": "dhtnqls1238",
                "crew_name": "광우상사",
                "nickname": "DB nickname",
                "note": "",
                "is_on_leave": False,
            }
        ]

        result = align_members(items, members)

        self.assertEqual(result[0]["crew_name"], "광우상사")
        self.assertEqual(result[0]["nickname"], "DB nickname")
        self.assertEqual(result[0]["current_month"]["total_balloons"], 1234)

    def test_deleted_and_uncollected_members_are_not_published(self):
        items = [
            {"user_id": "deleted", "crew_name": "FA"},
            {"user_id": "kept", "crew_name": "FA"},
        ]
        members = [
            {
                "user_id": "kept",
                "crew_name": "FA",
                "nickname": "kept",
                "note": "",
                "is_on_leave": False,
            },
            {
                "user_id": "new",
                "crew_name": "FA",
                "nickname": "new",
                "note": "",
                "is_on_leave": False,
            },
        ]

        self.assertEqual(
            [item["user_id"] for item in align_members(items, members)],
            ["kept"],
        )


if __name__ == "__main__":
    unittest.main()
