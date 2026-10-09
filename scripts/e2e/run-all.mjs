// Jalankan semua uji e2e (ACS sungguhan + simulator ONU) berurutan.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let failed = 0;
for (const f of ['vendors.mjs', 'wan.mjs', 'api.mjs', 'system.mjs']) {
  const r = spawnSync(process.execPath, [join(here, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} suite e2e GAGAL` : '\nSemua suite e2e LULUS');
process.exit(failed ? 1 : 0);
