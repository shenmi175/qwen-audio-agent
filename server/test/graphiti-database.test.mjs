import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ensureGraphitiComponent, graphitiDatabaseConfiguration } from '../../components/graphiti/lifecycle.mjs'
import { diagnosticsConfigurationFingerprint } from '../../components/diagnostics/lifecycle.mjs'

const envPrefix = 'QWEN_AUDIO_GRAPHITI_'
const tunnel = 'bolt://127.0.0.1:17688'
const external = {
  [envPrefix + 'NEO4J_URI']: tunnel,
  [envPrefix + 'NEO4J_PASSWORD']: 'fixture',
}

function useLocalComponent(t, options) {
  const env = {
    [envPrefix + 'ENABLED']: 'on',
    [envPrefix + 'MODE']: 'local',
    [envPrefix + 'PORT']: '8311',
    QWEN_AUDIO_MEMORY_PROVIDER: 'graphiti',
    ...options,
  }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test('chooses a Compose-managed database by default and an existing database with a loopback tunnel', () => {
  assert.deepEqual(graphitiDatabaseConfiguration({ GRAPHITI_NEO4J_BOLT_PORT: '7689' }), {
    management: 'compose',
    uri: 'bolt://127.0.0.1:7689',
    target: createHash('sha256').update('bolt://127.0.0.1:7689').digest('hex'),
    password: undefined,
  })
  assert.deepEqual(graphitiDatabaseConfiguration(external), {
    management: 'external',
    uri: tunnel,
    target: createHash('sha256').update(tunnel).digest('hex'),
    password: 'fixture',
  })
})

test('requires a private loopback Bolt endpoint with a valid port', () => {
  for (const uri of [
    'bolt://public.example:17688',
    'bolt://127.0.0.1:65536',
    'bolt://127.0.0.1',
    'neo4j://127.0.0.1:17688',
    'bolt://user:secret@localhost:17688',
    'bolt://localhost:17688/?routing=example',
  ]) {
    assert.throws(() => graphitiDatabaseConfiguration({
      ...external,
      [envPrefix + 'NEO4J_URI']: uri,
    }), /GRAPHITI_NEO4J_INVALID_URI/)
  }
  assert.throws(() => graphitiDatabaseConfiguration({
    [envPrefix + 'NEO4J_PASSWORD']: 'fixture',
  }), /GRAPHITI_NEO4J_URI_REQUIRED/)
})

test('rejects missing external Neo4j credentials before probing an existing component', async t => {
  useLocalComponent(t, { ...external, [envPrefix + 'NEO4J_PASSWORD']: '' })
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('must validate before probing'))
  await assert.rejects(ensureGraphitiComponent(), /GRAPHITI_NEO4J_PASSWORD_REQUIRED/)
  assert.equal(fetch.mock.callCount(), 0)
})

test('reuses a ready external database component with matching readiness metadata', async t => {
  useLocalComponent(t, external)
  const componentFiles = [
    'memory_provider.py', 'memory_tiers.py', 'official_mcp.py', 'qwen_schema_adapter.py', 'memory_policy.py',
    'mcp-config.yaml', 'requirements.lock', 'mcp_launcher.py', '../diagnostics/qwaudio_diagnostics/__init__.py',
  ]
  const integrationFingerprint = createHash('sha256').update(Buffer.concat(componentFiles.map(file =>
    readFileSync(new URL('../../components/graphiti/' + file, import.meta.url)),
  ))).digest('hex')
  const fetch = t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'http://127.0.0.1:8311/readyz')
    return {
      ok: true,
      json: async () => ({
        component: 'qwaudio-graphiti',
        status: 'ready',
        databaseManagement: 'external',
        databaseTarget: graphitiDatabaseConfiguration(external).target,
        integrationVersion: 6,
        integrationFingerprint,
        diagnostics: { configurationFingerprint: diagnosticsConfigurationFingerprint() },
        memoryIntegration: true,
      }),
    }
  })
  assert.equal((await ensureGraphitiComponent()).databaseManagement, 'external')
  assert.equal(fetch.mock.callCount(), 1)
})
