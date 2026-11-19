"""Launch the pinned official MCP with the selected text API."""
import os
import runpy
import sys
from pathlib import Path


def configure_native_openai(factories):
    upstream_effort_for_model = factories.reasoning_effort_for_model

    def effort_for_model(model):
        # GPT-6.1 Sol requires at least low reasoning effort.
        if model == 'gpt-6.1-sol' or model.startswith('gpt-6.1-sol-'):
            return 'low'
        return upstream_effort_for_model(model)

    factories.reasoning_effort_for_model = effort_for_model
    # This subprocess is explicitly configured for Responses, including at a custom endpoint.
    factories.is_non_openai_provider = lambda _: False


if __name__ == "__main__":
    upstream = Path(__file__).resolve().parents[2] / "runtime/components/graphiti/upstream/mcp_server"
    sys.path.insert(0, str(upstream / "src"))
    if os.environ.get('QWAUDIO_GRAPHITI_LLM_FAMILY') == 'openai':
        from services import factories

        configure_native_openai(factories)
    sys.argv[0] = str(upstream / "main.py")
    runpy.run_path(str(upstream / "main.py"), run_name="__main__")
