import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from memory_tiers import fetch_prompt, selected_tier, graph_extraction_prompt, MemoryErrorCode


class LocalMemoryPromptTests(unittest.TestCase):
    def test_graph_prompt_reloads_and_rejects_empty_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"QWAUDIO_PROMPTS_DIR": directory}, clear=True):
                self.assertIn("AttributeValue", graph_extraction_prompt())
                folder = Path(directory) / "memory"
                folder.mkdir()
                path = folder / "graph-extraction.md"
                path.write_text("edited graph policy")
                self.assertEqual(graph_extraction_prompt(), "edited graph policy")
                path.write_text("")
                with self.assertRaisesRegex(MemoryErrorCode, "MEMORY_PROMPT_INVALID"):
                    graph_extraction_prompt()

    def test_local_prompts_reload_for_new_jobs_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"QWAUDIO_PROMPTS_DIR": directory}, clear=True):
                self.assertEqual(selected_tier(), "medium")
                with self.assertRaisesRegex(MemoryErrorCode, "MEMORY_PROMPT_UNAVAILABLE"):
                    fetch_prompt()
                folder = Path(directory) / "memory"
                folder.mkdir()
                for tier in ("light", "medium", "advanced"):
                    path = folder / (tier + ".md")
                    path.write_text("rules " + tier)
                    before = fetch_prompt(tier)
                    self.assertEqual(before.source, "local")
                    path.write_text("updated " + tier)
                    after = fetch_prompt(tier)
                    self.assertNotEqual(before.version, after.version)
                    self.assertEqual(after.content, "updated " + tier)
                (folder / "medium.md").write_text("")
                with self.assertRaisesRegex(MemoryErrorCode, "MEMORY_PROMPT_INVALID"):
                    fetch_prompt()
                with self.assertRaisesRegex(MemoryErrorCode, "MEMORY_INVALID_TIER"):
                    fetch_prompt("../escape")


if __name__ == "__main__":
    unittest.main()
