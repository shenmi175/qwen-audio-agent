"""Optional diagnostics interface. Business components do not depend on Langfuse."""
import contextvars
import hashlib
import json
import os
import re
from contextlib import contextmanager

_metadata = contextvars.ContextVar("qwaudio_diagnostic_metadata", default={})
_recorder = None
_SECRET_KEYS = {"authorization", "api_key", "apikey", "password", "secret", "access_token", "refresh_token"}
_ALLOWED_METADATA = {"session_id", "user_id", "task_id", "version", "generation", "operation_id", "schema", "source_trace_id", "batch_id", "turn_id", "connection_id", "response_id", "call_id"}

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
    from opentelemetry.propagate import inject
    headers = {}
    inject(headers)
    if _metadata.get():
        headers["x-qwaudio-trace-metadata"] = json.dumps(_metadata.get(), separators=(",",":"))
    return headers

@contextmanager
def remote_context(headers):
    from opentelemetry import context
    from opentelemetry.propagate import extract
    safe = {k.lower():v for k,v in headers.items() if k.lower() in ("traceparent","tracestate")}
    token = context.attach(extract(safe))
    try:
        raw = headers.get("x-qwaudio-trace-metadata","{}")
        if len(raw) > 4096: raw = "{}"
        try: metadata = json.loads(raw)
        except (ValueError,TypeError): metadata = {}
        if not isinstance(metadata,dict): metadata = {}
        metadata = {k:v for k,v in metadata.items() if k in _ALLOWED_METADATA and isinstance(v,(str,int))}
        meta_token = _metadata.set(metadata)
        try: yield
        finally: _metadata.reset(meta_token)
    finally: context.detach(token)

def capture_context():
    from opentelemetry import context
    return context.get_current(),dict(_metadata.get())

@contextmanager
def restore_context(saved):
    from opentelemetry import context
    token = context.attach(saved[0])
    meta_token = _metadata.set(saved[1])
    try: yield
    finally:
        _metadata.reset(meta_token)
        context.detach(token)

class Observation:
    def __init__(self, span=None):
        self.span = span

    @property
    def trace_id(self):
        return format(self.span.get_span_context().trace_id,"032x") if self.span else None

    def update(self, **fields):
        if not self.span: return
        try:
            from .otlp import attributes
            self.span.set_attributes(attributes(fields))
            if fields.get("error"):
                from opentelemetry.trace import Status,StatusCode
                self.span.set_status(Status(StatusCode.ERROR,str(fields["error"])))
        except Exception: pass

class Recorder:
    def __init__(self):
        self.provider = os.environ.get("QWEN_AUDIO_DIAGNOSTICS_PROVIDER","off")
        self.configuration_fingerprint = hashlib.sha256(json.dumps([
            self.provider,os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",""),
            os.environ.get("OTEL_EXPORTER_OTLP_TRACES_HEADERS","")
        ],separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
        self.tracer = self.processor = None
        self.error = None
        if self.provider == "off": return
        if self.provider != "otlp":
            self.error = "DIAGNOSTICS_PROVIDER_UNSUPPORTED"; return
        try:
            from .otlp import initialize
            self.tracer,self.processor = initialize()
        except Exception:
            self.error = "DIAGNOSTICS_INITIALIZATION_FAILED"

    def health(self):
        return {"enabled":self.tracer is not None,"provider":self.provider,"code":self.error,
                "configurationFingerprint":self.configuration_fingerprint}

    @contextmanager
    def span(self, name, *, kind="span", input=None, metadata=None, model=None):
        values = {**_metadata.get(), **(metadata or {})}
        token = _metadata.set(values)
        try:
            if self.tracer is None:
                yield Observation(); return
            from .otlp import attributes
            from opentelemetry.trace import Status,StatusCode
            with self.tracer.start_as_current_span(name,
                attributes=attributes({"kind":kind,"input":input,"metadata":values,"model":model}),
                record_exception=False,set_status_on_exception=False) as span:
                observation = Observation(span)
                try: yield observation
                except BaseException as exc:
                    observation.update(error=type(exc).__name__)
                    span.set_status(Status(StatusCode.ERROR,type(exc).__name__))
                    raise
        finally: _metadata.reset(token)

    async def completion(self, client, *, name, **request):
        with self.span(name,kind="generation",input=request,model=request.get("model")) as observation:
            try:
                response = await client.chat.completions.create(**request)
            except Exception as exc:
                observation.update(output={'error':{'type':type(exc).__name__,
                    'status_code':getattr(exc,'status_code',None),
                    'request_id':getattr(exc,'request_id',None),'body':getattr(exc,'body',None)}})
                raise
            if self.tracer is not None:
                try: observation.update(output=response.model_dump(mode="json",exclude_none=True))
                except Exception: observation.update(error="DIAGNOSTICS_CAPTURE_FAILED")
            usage = getattr(response,"usage",None)
            if usage:
                observation.update(input_tokens=getattr(usage,"prompt_tokens",None),
                                   output_tokens=getattr(usage,"completion_tokens",None))
            return response

    def flush(self, timeout_ms=3000):
        if self.processor:
            try: self.processor.force_flush(timeout_millis=timeout_ms)
            except Exception: pass

def get_recorder():
    global _recorder
    if _recorder is None: _recorder = Recorder()
    return _recorder
