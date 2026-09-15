import unittest

import httpx

import main


class LiveStatusTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        main._public_live_ids = set()
        main._public_live_checked_at = 0.0

    async def test_restricted_live_uses_one_shared_public_roster(self):
        requests = []

        async def handler(request):
            requests.append((request.method, str(request.url)))
            if request.method == "POST":
                return httpx.Response(
                    200,
                    json={
                        "CHANNEL": {
                            "RESULT": -6,
                            "TITLE": "19세 이상 방송",
                            "BPWD": "N",
                        }
                    },
                )
            return httpx.Response(200, text="dhtnqls1238,another_live")

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            first = await main.fetch_live_status(client, "dhtnqls1238")
            second = await main.fetch_live_status(client, "dhtnqls1238")

        self.assertTrue(first["is_live"])
        self.assertTrue(second["is_live"])
        self.assertEqual(sum(method == "GET" for method, _ in requests), 1)

    async def test_restricted_id_missing_from_roster_is_offline(self):
        async def handler(request):
            if request.method == "POST":
                return httpx.Response(
                    200,
                    json={"CHANNEL": {"RESULT": "-8", "TITLE": "restricted"}},
                )
            return httpx.Response(200, text="someone_else")

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            status = await main.fetch_live_status(client, "dhtnqls1238")

        self.assertFalse(status["is_live"])

    async def test_password_broadcast_never_uses_roster(self):
        async def handler(request):
            self.assertEqual(request.method, "POST")
            return httpx.Response(
                200,
                json={
                    "CHANNEL": {
                        "RESULT": -6,
                        "TITLE": "password",
                        "BPWD": "Y",
                    }
                },
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            status = await main.fetch_live_status(client, "dhtnqls1238")

        self.assertFalse(status["is_live"])
        self.assertTrue(status["is_password"])


if __name__ == "__main__":
    unittest.main()
