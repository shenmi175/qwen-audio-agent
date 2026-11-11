import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { root, state } from './lifecycle.mjs'
export function initialize({ url, bind = '127.0.0.1', certificate, key }) {
  if (!url || new URL(url).protocol !== 'https:' || !certificate || !key)
    throw new Error('Supply --url https://host:port --certificate path --key path')
  const path = resolve(state, 'service.env')
  if (existsSync(path)) throw new Error('Private configuration already exists; it was not overwritten')
  const random = () => randomBytes(24).toString('hex')
  const env = {
    LANGFUSE_IMAGE_TAG:'4.78.0', NEXTAUTH_URL:url, NEXTAUTH_SECRET:random(),
    SALT:random(),ENCRYPTION_KEY:randomBytes(32).toString('hex'),
    POSTGRES_PASSWORD:random(),CLICKHOUSE_PASSWORD:random(),REDIS_AUTH:random(),
    MINIO_ROOT_USER:'qwaudio',MINIO_ROOT_PASSWORD:random(),
    LANGFUSE_INIT_ORG_ID:'qwaudio',LANGFUSE_INIT_ORG_NAME:'Qwen Audio',
    LANGFUSE_INIT_PROJECT_ID:'qwaudio-diagnostics',LANGFUSE_INIT_PROJECT_NAME:'Conversation diagnostics',
    LANGFUSE_INIT_USER_EMAIL:'admin@qwaudio.local',LANGFUSE_INIT_USER_NAME:'Administrator',
    LANGFUSE_INIT_USER_PASSWORD:random(),
    LANGFUSE_INIT_PROJECT_PUBLIC_KEY:'pk-lf-'+random(),
    LANGFUSE_INIT_PROJECT_SECRET_KEY:'sk-lf-'+random(),
    LANGFUSE_TLS_CERT:resolve(certificate),LANGFUSE_TLS_KEY:resolve(key),
    LANGFUSE_BIND:bind,LANGFUSE_HTTPS_PORT:new URL(url).port || '443',
  }
  env.DATABASE_URL='postgresql://postgres:'+env.POSTGRES_PASSWORD+'@postgres:5432/postgres'
  mkdirSync(state,{recursive:true,mode:0o700})
  writeFileSync(path,Object.entries(env).map(([k,v])=>k+'='+v+'\n').join(''),{mode:0o600,flag:'wx'})
  const diagnostics = resolve(root,'runtime/components/diagnostics')
  mkdirSync(diagnostics,{recursive:true,mode:0o700})
  const auth=Buffer.from(env.LANGFUSE_INIT_PROJECT_PUBLIC_KEY+':'+env.LANGFUSE_INIT_PROJECT_SECRET_KEY).toString('base64')
  const config=resolve(diagnostics,'service.env')
  if (!existsSync(config)) writeFileSync(config,
    'QWEN_AUDIO_DIAGNOSTICS_PROVIDER=otlp\nOTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:3300/api/public/otel/v1/traces\n'
    +'OTEL_EXPORTER_OTLP_TRACES_HEADERS=Authorization=Basic%20'+auth+',x-langfuse-ingestion-version=4\n',
    {mode:0o600,flag:'wx'})
  writeFileSync(resolve(state,'login.txt'),'URL: '+url+'\nUser: '+env.LANGFUSE_INIT_USER_EMAIL
    +'\nPassword: '+env.LANGFUSE_INIT_USER_PASSWORD+'\n',{mode:0o600,flag:'wx'})
}
