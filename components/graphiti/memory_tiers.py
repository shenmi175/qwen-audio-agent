"""User-selected memory extraction tiers and Langfuse prompt resolution."""
import base64
import json
import os
import urllib.parse
import urllib.request
from pathlib import Path
from dataclasses import dataclass
from memory_queue import MemoryErrorCode

TIERS = ("light", "medium", "advanced")
DEFAULT_TIER = "medium"
MODEL_ALIASES = {"light": "qwen-flash", "medium": "qwen-plus", "advanced": "qwen-max"}

@dataclass(frozen=True)
class MemoryPrompt:
    name: str
    version: int | None
    content: str
    source: str = "langfuse"

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

def _langfuse_url(name):
    base = os.environ.get("LANGFUSE_BASE_URL", "").rstrip("/")
    if not base:
        raise MemoryErrorCode("MEMORY_PROMPT_UNAVAILABLE")
    return base + "/api/public/v2/prompts/" + urllib.parse.quote(name, safe="") + "?label=production"

def fetch_prompt(tier=None):
    tier = tier or selected_tier()
    name = os.environ.get("GRAPHITI_MEMORY_PROMPT_" + tier.upper(), "memory/observation/" + tier)
    public = os.environ.get("LANGFUSE_PUBLIC_KEY", "")
    secret = os.environ.get("LANGFUSE_SECRET_KEY", "")
    if not public or not secret:
        raise MemoryErrorCode("MEMORY_PROMPT_UNAVAILABLE")
    token = base64.b64encode((public + ":" + secret).encode()).decode()
    request = urllib.request.Request(_langfuse_url(name), headers={"Authorization": "Basic " + token, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            payload = json.loads(response.read().decode())
    except Exception as exc:
        raise MemoryErrorCode("MEMORY_PROMPT_UNAVAILABLE") from exc
    content = payload.get("prompt")
    if isinstance(content, list):
        content = "\n".join(str(item.get("content", "")) for item in content if isinstance(item, dict))
    if not isinstance(content, str) or not content.strip():
        raise MemoryErrorCode("MEMORY_PROMPT_INVALID")
    return MemoryPrompt(name=name, version=payload.get("version"), content=content)
