"""Local compatibility interface without diagnostic exporters."""
import hashlib
import json
import os
import re
from contextlib import contextmanager
_recorder = None
_SECRET_KEYS = {"authorization", "api_key", "apikey", "password", "secret", "access_token", "refresh_token"}
def redact(value):
    secrets = [v for k,v in os.environ.items()
        if re.search(r"(API_KEY|TOKEN|PASSWORD|SECRET)$", k) and len(v) >= 12]
    def clean(v):
        if isinstance(v, dict):
            return {str(k): "[REDACTED]" if str(k).lower() in _SECRET_KEYS else clean(x) for k,x in v.items()}
        if isinstance(v, (list,tuple)): return [clean(x) for x in v]
        if isinstance(v, str):
            for secret in secrets: v = v.replace(secret, "[REDACTED]")
            return re.sub(r"\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})", "[REDACTED]", v)
        if v is None or isinstance(v,(bool,int,float)): return v
        return str(v)
    return clean(value)


def carrier():
    return {}

@contextmanager
def remote_context(headers):
    yield

def capture_context():
    return None

@contextmanager
def restore_context(saved):
    yield

class Observation:
    trace_id = None
    def update(self, **fields):
        pass

class Recorder:
    def __init__(self):
        self.tracer = self.processor = None
        self.configuration_fingerprint = hashlib.sha256(json.dumps(["off", "", ""], separators=(",", ":")).encode()).hexdigest()
    def health(self):
        return {"enabled": False, "provider": "off", "code": None,
                "configurationFingerprint": self.configuration_fingerprint}
    @contextmanager
    def span(self, name, **kwargs):
        yield Observation()
    async def completion(self, client, *, name, **request):
        return await client.chat.completions.create(**request)
    def flush(self, timeout_ms=3000):
        pass

def get_recorder():
    global _recorder
    if _recorder is None:
        _recorder = Recorder()
    return _recorder
