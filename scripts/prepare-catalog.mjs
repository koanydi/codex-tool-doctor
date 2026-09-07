import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadConfig, defaultHome, sanitize } from '../src/config.mjs';
import { discoverBinaries, loadCatalog } from '../src/binaries.mjs';
import { makePatchedCatalog } from '../src/patch.mjs';
import { friendlyError } from '../src/ui.mjs';

async function main() {
  const { values } = parseArgs({ options: { binary: {type:'string'}, home: {type:'string'}, output: {type:'string'} } });
  if (!values.output) throw new Error('请用 --output 指定新的候选 JSON 文件路径；已有文件不会被覆盖。');
  const context = await loadConfig(values.home || defaultHome());
  if (context.config.model_catalog_json) throw new Error('已有 model_catalog_json 覆盖，请先检查现有配置，不应叠加此候选补丁。');
  const binaries = await discoverBinaries(values.binary);
  const catalog = await loadCatalog(binaries[0].path, context.home);
  const candidate = makePatchedCatalog(catalog, context.config.model);
  const output = resolve(values.output);
  await mkdir(dirname(output), {recursive:true});
  await writeFile(output, JSON.stringify(candidate, null, 2) + '\n', {flag:'wx',mode:0o600});
  for (const binary of binaries) {
    const effective = await loadCatalog(binary.path, context.home, output);
    if (effective.models.find(m => m.slug === context.config.model)?.use_responses_lite !== false) throw new Error('后端未接受候选目录。文件仅保留用于排查，不能视为有效补丁。');
  }
  console.log(`已生成候选模型目录：${output}\n模型：${context.config.model}\n只修改 use_responses_lite：true → false。全局配置未修改。\n下一步使用 verify --catalog 测试真实终端；此结果不代表 Linux 构建已通过认证。`);
}
main().catch(error => { console.error(`错误：${sanitize(friendlyError(error))}`); process.exitCode = 1; });
