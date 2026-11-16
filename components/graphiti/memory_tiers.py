"""User-selected memory extraction tiers and local prompt resolution."""
import hashlib
import os
from pathlib import Path
from dataclasses import dataclass
from memory_queue import MemoryErrorCode

TIERS = ("light", "medium", "advanced")
DEFAULT_TIER = "medium"
MODEL_ALIASES = {"light": "qwen-flash", "medium": "qwen-plus", "advanced": "qwen-max"}

@dataclass(frozen=True)
class MemoryPrompt:
    name: str
    version: str | int | None
    content: str
    source: str = "local"

def _tier_file():
    configured = os.environ.get("GRAPHITI_MEMORY_TIER_FILE")
    if configured:
        return Path(configured)
    queue = os.environ.get("GRAPHITI_QUEUE_PATH")
    return Path(queue).with_name("memory_tier") if queue else None

def selected_tier():
    value = os.environ.get("GRAPHITI_MEMORY_TIER", "").strip().lower()
    if not value:
        path = _tier_file()
        try:
            value = path.read_text().strip().lower() if path else ""
        except OSError:
            value = ""
    value = value or DEFAULT_TIER
    if value not in TIERS:
        raise MemoryErrorCode("MEMORY_INVALID_TIER")
    return value

def tier_model(tier=None):
    tier = tier or selected_tier()
    if tier not in TIERS:
        raise MemoryErrorCode("MEMORY_INVALID_TIER")
    return os.environ.get("GRAPHITI_MEMORY_MODEL_" + tier.upper(), MODEL_ALIASES[tier])

def fetch_prompt(tier=None):
    tier = tier or selected_tier()
    if tier not in TIERS:
        raise MemoryErrorCode("MEMORY_INVALID_TIER")
    directory = Path(os.environ.get("QWAUDIO_PROMPTS_DIR") or Path(__file__).resolve().parents[2] / "runtime/prompts")
    try:
        content = (directory / "memory" / (tier + ".md")).read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise MemoryErrorCode("MEMORY_PROMPT_UNAVAILABLE") from exc
    if not content.strip():
        raise MemoryErrorCode("MEMORY_PROMPT_INVALID")
    return MemoryPrompt(name="memory/observation/" + tier,
                        version=hashlib.sha256(content.encode()).hexdigest()[:12], content=content)
