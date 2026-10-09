// E2E: trafik live (Mbps) — sesi ditahan, poll counter, wrap 32-bit,
// fallback counter, ONU tanpa counter, durasi & berhenti otomatis.
import { makeDevice, settle, inform } from './sim.mjs';
import { startAcs, reporter, idOf } from './harness.mjs';

const acs = await startAcs();
const t = reporter('Trafik live (Mbps)');
const zte = makeDevice('zte', 'ZTEGLIVE', { traffic: { down: 50, up: 10 } });
const hw = makeDevice('huawei', 'HWTCLIVE', { traffic: { down: 120, up: 30 } });
const cm = makeDevice('cmcc', 'CMCCLIVE', {});
for (const d of [zte, hw, cm]) await settle(d, acs.cwmp);

async function run(dev, seconds) {
  const r = await acs.call('POST', `/api/devices/${idOf(dev)}/live`, { seconds, intervalSec: 2 });
  dev.log = [];
  const t0 = Date.now();
  await inform(dev, acs.cwmp, '6 CONNECTION REQUEST'); // ONU menjawab Connection Request
  const st = await acs.get(`/api/devices/${idOf(dev)}/live`);
  return { start: r, st, ms: Date.now() - t0, gpv: dev.log.filter((m) => m === 'GetParameterValues').length };
}
const avg = (a, k) => a.reduce((s, x) => s + x[k], 0) / (a.length || 1);

let z = await run(zte, 12);
t.check(z.start.status === 200 && z.start.body.status === 'waiting', 'mulai live → menunggu sesi ONU');
t.check(z.st.status === 'done' && z.st.samples.length >= 4, `ZTE: ${z.st.samples.length} sampel dalam ${Math.round(z.ms / 1000)} dtk, status ${z.st.status}`);
t.check(Math.abs(avg(z.st.samples, 'down') - 50) < 3 && Math.abs(avg(z.st.samples, 'up') - 10) < 1.5,
  `ZTE ±50/10 Mbps (rata-rata ${avg(z.st.samples, 'down').toFixed(1)}/${avg(z.st.samples, 'up').toFixed(1)}) — termasuk wrap counter 32-bit`);
t.check(/Stats\.EthernetBytesReceived$/.test(z.st.source?.rx ?? ''), `ZTE sumber: ${z.st.source?.label}`);
t.check(z.ms < 12_000 + 8_000, 'sesi berakhir sendiri setelah durasi habis');

const h = await run(hw, 8);
t.check(h.st.samples.length >= 2 && Math.abs(avg(h.st.samples, 'down') - 120) < 6, `Huawei fallback ke ${h.st.source?.label}: ±${avg(h.st.samples, 'down').toFixed(1)} Mbps`);

const c = await run(cm, 8);
t.check(c.st.status === 'error' && /counter/.test(c.st.message ?? ''), `CMCC tanpa counter → "${c.st.message}"`);
t.check(c.ms < 8000, `ONU tanpa counter tidak ditahan lama (${c.ms} ms)`);

// Berhenti manual
await acs.call('POST', `/api/devices/${idOf(zte)}/live`, { seconds: 60, intervalSec: 2 });
setTimeout(() => void acs.call('DELETE', `/api/devices/${idOf(zte)}/live`), 4500);
const t0 = Date.now();
await inform(zte, acs.cwmp, '6 CONNECTION REQUEST');
t.check(Date.now() - t0 < 12_000 && (await acs.get(`/api/devices/${idOf(zte)}/live`)).status === 'stopped', 'tombol Hentikan mengakhiri sesi live');
t.done(acs);
