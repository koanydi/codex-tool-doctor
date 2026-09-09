import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute } from '../src/engine.mjs';
import { loadConfig } from '../src/config.mjs';
import { discoverBinaries, loadCatalog } from '../src/binaries.mjs';
import { makePatchedCatalog } from '../src/patch.mjs';
import { verify } from '../src/verify.mjs';
import { createMockRouter } from '../scripts/mock-router.mjs';

const binary = process.env.TOOL_DOCTOR_INTEGRATION_BINARY;
test('real Codex backend exercises local routing and respects actual terminal policy', { skip: !binary, timeout: 120000 }, async t => {
  const scratch = fileURLToPath(new URL('../.scratch/', import.meta.url));
  await mkdir(scratch, { recursive: true });
  const home = await mkdtemp(join(scratch, 'doctor-real-codex-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const observed = [];
  const router = await createMockRouter({ onRequest: request => observed.push({ path: request.path, toolNames: request.toolNames }) });
  t.after(() => router.close());
  const raw = `model="gpt-6-astra"\nmodel_provider="local"\n[model_providers.local]\nname="local fixture"\nbase_url="${router.url}/router/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`;
  await writeFile(join(home, 'config.toml'), raw);
  const context = await loadConfig(home), binaries = await discoverBinaries(binary);
  const bundled = await loadCatalog(binary, home), candidate = makePatchedCatalog(bundled, context.config.model), catalogPath = join(home, 'candidate with spaces.json');
  await writeFile(catalogPath, JSON.stringify(candidate));
  const preliminary = await verify(context, binaries, { catalogPath, timeout: 35000 });
  if (!preliminary.passed) {
    assert.equal(preliminary.results[0].failureKind, 'permission-blocked', JSON.stringify({ preliminary, observed }, null, 2));
    assert.ok(observed.some(request => request.toolNames.some(tool => tool.name === 'exec' && tool.type === 'custom')));
    assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), raw);
    t.diagnostic('真实后端接受候选目录并完成本地Responses往返；本机策略阻止终端执行，未安装补丁。终端成功路径由独立故障夹具验证。');
    if (process.env.TOOL_DOCTOR_REQUIRE_TERMINAL === '1') assert.fail('此环境要求真实终端成功，但本机策略阻止了执行。');
    return;
  }
  const result = await execute('repair', { home, binary });
  assert.equal(result.status, 'verified');
  await appendFile(join(home, 'config.toml'), '\n# Later user edit\n');
  await execute('rollback', { home, binary });
  assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), raw + '\n# Later user edit\n');
  assert.ok(observed.every(request => request.path === '/router/v1/responses'));
});
