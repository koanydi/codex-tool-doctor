import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { isIP } from 'node:net';
import { parse as parseToml } from 'smol-toml';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const defaultHome = () => resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
export function stateDir(home, profile) {
  if (profile && !/^[\w-]+$/.test(profile)) throw new Error('配置名称只能包含字母、数字、下划线和短横线。');
  return profile ? join(home, 'tool-doctor', 'profiles', profile) : join(home, 'tool-doctor');
}
export async function readJson(path) {
  const raw = await readFile(path, 'utf8');
  try { return JSON.parse(raw); }
  catch { throw new Error('JSON文件格式无效，请检查文件结构。为保护凭据，不显示文件内容。'); }
}
export function parseConfig(raw) {
  try { return parseToml(raw); }
  catch (error) {
    const location = Number.isInteger(error.line) && Number.isInteger(error.column) ? `（第${error.line}行，第${error.column}列）` : '';
    throw new Error(`TOML配置格式无效${location}。请检查语法；为保护凭据，不显示配置原文。`);
  }
}
export async function readOptionalJson(path) {
  try { return await readJson(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, value, { flag: 'wx', mode: 0o600 }); await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
}
export const saveJson = (path, value) => atomicWrite(path, JSON.stringify(value, null, 2) + '\n');

export function isLocalHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (isIP(host) === 6) return host === '::1' || /^(fc|fd|fe[89ab])/.test(host);
  return !host.includes('.') && /^[a-z0-9-]+$/.test(host);
}
export function responseEndpoint(baseUrl, { allowInsecureHttp = false, queryParams = {} } = {}) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('base_url不是有效的绝对URL，请包含http://或https://。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('上游需要HTTP/HTTPS地址；URL不能包含用户名、密码或片段。');
  if (url.protocol === 'http:' && !isLocalHost(url.hostname) && !allowInsecureHttp) throw new Error('公网HTTP会明文发送凭据。请使用HTTPS；确需此地址时显式使用--allow-insecure-http。');
  if (url.search) throw new Error('base_url中的查询参数请移至provider.query_params，避免泄露凭据。');
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/responses') ? path : path + '/responses';
  for (const [key, value] of Object.entries(queryParams)) url.searchParams.set(key, String(value));
  return url.href;
}
export function displayEndpoint(endpoint) {
  const url = new URL(endpoint);
  for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[REDACTED]');
  return url.href;
}
function merge(base, overlay) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) result[key] = value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' ? merge(base[key], value) : value;
  return result;
}
export async function loadConfig(home = defaultHome(), options = {}) {
  home = resolve(home);
  const profile = options.profile || null;
  const directory = stateDir(home, profile);
  const basePath = join(home, 'config.toml');
  const baseRaw = await readFile(basePath, 'utf8');
  const configPath = profile ? join(home, `${profile}.config.toml`) : basePath;
  const raw = profile ? await readFile(configPath, 'utf8') : baseRaw;
  const base = parseConfig(baseRaw);
  const config = profile ? merge(base, parseConfig(raw)) : base;
  if (config.profile || config.profiles) throw new Error('检测到旧版profiles配置。请迁移为<名称>.config.toml，再使用--profile选择，避免修复错误的配置层。');
  const providerId = config.model_provider || 'openai';
  if (providerId === 'openai' && Object.keys(config.model_providers?.openai || {}).length) throw new Error('本工具无法确认model_providers.openai覆盖与Codex实际配置一致，已拒绝继续。请改用自定义model_provider名称；仅更改内置服务地址请使用openai_base_url。');
  const provider = providerId === 'openai'
    ? { wire_api: 'responses', requires_openai_auth: true, base_url: config.openai_base_url || 'https://api.openai.com/v1' }
    : config.model_providers?.[providerId];
  if (!provider?.base_url) throw new Error('需要在配置中指定服务提供方及其base_url。');
  if ((provider.wire_api || 'responses') !== 'responses') throw new Error('目前仅支持wire_api="responses"。Chat Completions服务需要先提供Responses兼容接口。');
  const endpoint = responseEndpoint(provider.base_url, { ...options, queryParams: provider.query_params });
  if (!config.model) throw new Error('config.toml中尚未选择模型。');
  return { home, profile, directory, options: { profile, allowInsecureHttp: Boolean(options.allowInsecureHttp) }, configPath, baseRaw, raw, config, providerId, provider, endpoint, displayEndpoint: displayEndpoint(endpoint), configHash: hash(raw), contextHash: hash(baseRaw + '\0' + raw + '\0' + endpoint) };
}
export async function loadCredential(context, env = process.env) {
  const provider = context.provider;
  if (provider.auth?.command) throw new Error('此provider使用外部凭据助手。诊断暂不执行助手，请通过env_key提供临时凭据后再检测。');
  if (provider.env_key) {
    if (!env[provider.env_key]) throw new Error(`缺少配置指定的凭据环境变量：${provider.env_key}。`);
    return env[provider.env_key];
  }
  if (provider.experimental_bearer_token) return provider.experimental_bearer_token;
  // A custom provider must explicitly opt in to reusing account API credentials.
  if (provider.requires_openai_auth === false || (context.providerId !== 'openai' && provider.requires_openai_auth !== true)) return '';
  const auth = await readOptionalJson(join(context.home, 'auth.json'));
  const key = auth?.OPENAI_API_KEY || env.OPENAI_API_KEY;
  if (!key && (provider.requires_openai_auth || context.providerId === 'openai')) throw new Error('未找到API密钥。本工具不使用ChatGPT会话令牌。无认证本地路由可设置requires_openai_auth=false。');
  return key || '';
}
export async function requestAuth(context, env = process.env) {
  const key = await loadCredential(context, env);
  const headers = {};
  if (key) headers.authorization = `Bearer ${key}`;
  const setHeader = (name, value) => {
    if (typeof value !== 'string' || /[\r\n]/.test(value) || !/^[!#$%&'*+.^_`|~\w-]+$/.test(name)) throw new Error('provider请求头格式无效。');
    if (['host', 'content-length', 'connection', 'transfer-encoding'].includes(name.toLowerCase())) throw new Error(`不能覆盖传输请求头：${name}。`);
    headers[name.toLowerCase()] = value;
  };
  for (const [name, value] of Object.entries(context.provider.http_headers || {})) setHeader(name, value);
  for (const [name, envName] of Object.entries(context.provider.env_http_headers || {})) {
    if (!env[envName]) throw new Error(`缺少请求头所需的环境变量：${envName}。`);
    setHeader(name, env[envName]);
  }
  const secrets = [key, ...Object.values(headers), ...Object.values(context.provider.query_params || {}).map(String)].filter(Boolean);
  return { key, headers, secrets };
}
export function sanitize(text, secrets = []) {
  let result = String(text);
  for (const secret of (Array.isArray(secrets) ? secrets : [secrets]).filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(secret).join('[REDACTED]');
  return result.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]');
}
