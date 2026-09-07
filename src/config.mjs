import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { parse } from 'smol-toml';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const defaultHome = () => resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
export const stateDir = home => join(home, 'tool-doctor');
export const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

export async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, value, { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export const saveJson = (path, value) => atomicWrite(path, JSON.stringify(value, null, 2) + '\n');

export async function loadConfig(home = defaultHome()) {
  home = resolve(home);
  const configPath = join(home, 'config.toml');
  const raw = await readFile(configPath, 'utf8');
  const config = parse(raw);
  const providerId = config.model_provider || 'openai';
  const provider = config.model_providers?.[providerId];
  if (!provider?.base_url) throw new Error('需要在配置中指定自定义服务提供方及其 base_url。');
  if (provider.wire_api !== 'responses') throw new Error('目前仅支持 wire_api = "responses"。');
  const endpoint = new URL(provider.base_url.replace(/\/+$/, '') + '/responses');
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('上游必须使用 HTTPS，URL 中不能包含凭据、查询参数或片段。');
  }
  if (!config.model) throw new Error('config.toml 中尚未选择模型。');
  return { home, configPath, raw, config, providerId, provider, endpoint: endpoint.href, configHash: hash(raw) };
}

export async function loadCredential(context) {
  const envKey = context.provider.env_key;
  if (envKey) {
    if (!process.env[envKey]) throw new Error(`缺少配置指定的凭据环境变量：${envKey}。`);
    return process.env[envKey];
  }
  const auth = await readJson(join(context.home, 'auth.json')).catch(() => ({}));
  const key = auth.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('未找到 API 密钥。本工具不使用 ChatGPT 会话令牌。');
  return key;
}

export function sanitize(text, secret = '') {
  let result = String(text);
  if (secret) result = result.split(secret).join('[REDACTED]');
  return result.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]');
}
