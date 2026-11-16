import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from qwaudio_diagnostics import Recorder, carrier, remote_context

class Tests(unittest.IsolatedAsyncioTestCase):
    async def test_passthrough_preserves_result_and_error_without_exporting(self):
        create = AsyncMock(return_value=object())
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        recorder = Recorder()
        result = await recorder.completion(client, name="test", model="synthetic")
        self.assertIs(result, create.return_value)
        create.assert_awaited_once_with(model="synthetic")
        self.assertFalse(recorder.health()["enabled"])
        self.assertEqual(carrier(), {})
        create.side_effect = RuntimeError("business failure")
        with self.assertRaisesRegex(RuntimeError, "business failure"):
            with remote_context({}):
                await recorder.completion(client, name="test", model="synthetic")

if __name__ == "__main__":
    unittest.main()
