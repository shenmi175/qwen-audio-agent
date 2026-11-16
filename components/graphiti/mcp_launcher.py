"""Launch the pinned official MCP without diagnostic instrumentation."""
import runpy
import sys
from pathlib import Path

if __name__ == "__main__":
    upstream = Path(__file__).resolve().parents[2] / "runtime/components/graphiti/upstream/mcp_server"
    sys.path.insert(0, str(upstream / "src"))
    sys.argv[0] = str(upstream / "main.py")
    runpy.run_path(str(upstream / "main.py"), run_name="__main__")
