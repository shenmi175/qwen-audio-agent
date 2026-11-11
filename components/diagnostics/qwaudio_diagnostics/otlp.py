"""OTLP exporter and backend field mapping, isolated from business components."""
import json
import os
from urllib.parse import unquote
from . import redact

def attributes(fields):
    attrs = {"langfuse.trace.public":False}
    metadata = fields.get("metadata") or {}
    for key,value in metadata.items():
        if value is not None:
            attrs["qwaudio."+key] = value
            attrs["langfuse.observation.metadata."+key] = str(value)
            attrs["langfuse.trace.metadata."+key] = str(value)
    if metadata.get("session_id"): attrs["session.id"] = str(metadata["session_id"])
    if metadata.get("user_id"): attrs["user.id"] = str(metadata["user_id"])
    if "kind" in fields:
        kind = fields["kind"]
        attrs["langfuse.observation.type"] = kind
        attrs["openinference.span.kind"] = {"generation":"LLM","tool":"TOOL"}.get(kind,"CHAIN")
    for key in ("input","output"):
        if key in fields and fields[key] is not None:
            value = json.dumps(redact(fields[key]),ensure_ascii=False,default=str)
            attrs["langfuse.observation."+key] = value
            attrs[key+".value"] = value
            attrs[key+".mime_type"] = "application/json"
    if fields.get("model"):
        attrs["gen_ai.request.model"] = fields["model"]
        attrs["llm.model_name"] = fields["model"]
    for source,target in (("input_tokens","input"),("output_tokens","output")):
        if fields.get(source) is not None:
            attrs["gen_ai.usage."+target+"_tokens"] = fields[source]
    if fields.get("error"):
        attrs["error.type"] = fields["error"]
        attrs["langfuse.observation.level"] = "ERROR"
        attrs["langfuse.observation.status_message"] = fields["error"]
    return attrs

def initialize():
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    endpoint = os.environ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]
    headers = {}
    for part in os.environ.get("OTEL_EXPORTER_OTLP_TRACES_HEADERS","").split(","):
        if "=" in part:
            key,value = part.split("=",1);headers[key.strip()] = unquote(value.strip())
    exporter = OTLPSpanExporter(endpoint=endpoint,headers=headers,timeout=3)
    provider = TracerProvider(resource=Resource.create({"service.name":"qwaudio-memory"}))
    processor = BatchSpanProcessor(exporter,max_queue_size=2048,schedule_delay_millis=1000,
        max_export_batch_size=128,export_timeout_millis=3000)
    provider.add_span_processor(processor)
    return provider.get_tracer("qwaudio.diagnostics","0.1.0"),processor
