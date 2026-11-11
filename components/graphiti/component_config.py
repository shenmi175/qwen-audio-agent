"""Component-owned configuration; no fallback fact files or secret logging."""
import os
from pathlib import Path


def graphiti_settings():
    return {'enabled': True, 'provider': 'graphiti',
        'queue_path': os.environ.get('GRAPHITI_QUEUE_PATH', str(Path(__file__).resolve().parents[2] / 'runtime/components/graphiti/queue.sqlite3')),
        'uri': os.environ['GRAPHITI_NEO4J_URI'], 'user': 'neo4j', 'password': os.environ['GRAPHITI_NEO4J_PASSWORD'],
        'base_url': os.environ['GRAPHITI_LLM_BASE_URL'], 'llm_model': os.environ['GRAPHITI_LLM_MODEL'],
        'embedding_base_url': os.environ['GRAPHITI_EMBEDDING_BASE_URL'],
        'embedding_api_key': os.environ.get('GRAPHITI_EMBEDDING_API_KEY'),
        'embedding_model': os.environ['GRAPHITI_EMBEDDING_MODEL'],
        'embedding_dim': int(os.environ.get('GRAPHITI_EMBEDDING_DIM', '1024')),
        'query_timeout_ms': 10000, 'recall_timeout_ms': 5000, 'write_timeout_ms': 300000}


def load_qwen_key():
    key = os.environ.get('GRAPHITI_LLM_API_KEY')
    if not key: raise RuntimeError('GRAPHITI_AUTH_FAILED')
    return key
