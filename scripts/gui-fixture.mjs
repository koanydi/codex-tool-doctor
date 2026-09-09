// Development-only GUI fixture. Uses an isolated configuration and a loopback mock API.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockRouter } from './mock-router.mjs';
import { startGui } from '../src/gui.mjs';
const scratch = fileURLToPath(new URL('../.scratch/', import.meta.url));
await mkdir(scratch, { recursive: true });
const home = await mkdtemp(join(scratch, 'gui-fixture-'));
const router = await createMockRouter({ mode: 'malformed-stream' });
await writeFile(join(home, 'config.toml'), `model="gpt-6-astra"\nmodel_provider="local"\n[model_providers.local]\nname="本地模拟路由"\nbase_url="${router.url}/v1"\nrequires_openai_auth=false\n`);
const gui = await startGui({ home });
console.log(gui.url);
const stop = async () => { await gui.close(); await router.close(); await rm(home, { recursive: true, force: true }); process.exit(0); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
