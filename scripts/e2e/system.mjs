// E2E: CPU/RAM multi-vendor, upgrade profil v3 -> v4, beban siklus rutin.
import { DatabaseSync } from 'node:sqlite';
import { makeDevice, inform, settle } from './sim.mjs';
import { startAcs, reporter, idOf } from './harness.mjs';

const acs = await startAcs();
const t = reporter('CPU / RAM semua vendor');
const devs = ['zte', 'huawei', 'cmcc', 'fiberhome'].map((v) => makeDevice(v, `${v.toUpperCase()}SYS`, {}));
for (const d of devs) await settle(d, acs.cwmp);
const by = Object.fromEntries((await acs.get('/api/devices?limit=50')).items.map((d) => [d.serial_number, d]));
t.check(by.ZTESYS.cpu_usage === 12 && by.ZTESYS.mem_usage === 50, `ZTE standar TR-098: CPU ${by.ZTESYS.cpu_usage}% RAM ${by.ZTESYS.mem_usage}%`);
t.check(by.HUAWEISYS.cpu_usage === 33 && by.HUAWEISYS.mem_usage === 41, `Huawei X_HW_CpuUsed/MemUsed: CPU ${by.HUAWEISYS.cpu_usage}% RAM ${by.HUAWEISYS.mem_usage}%`);
t.check(by.CMCCSYS.cpu_usage === 7 && by.CMCCSYS.mem_usage === 75, `CMCC objek vendor (byte): CPU ${by.CMCCSYS.cpu_usage}% RAM ${by.CMCCSYS.mem_usage}%`);
t.check(by.FIBERHOMESYS.cpu_usage === null && by.FIBERHOMESYS.mem_usage === null, 'FiberHome tanpa data → kosong (tidak ditebak)');
const cm = await acs.get(`/api/devices/${idOf(devs[2])}`);
t.check(cm.insight.system.memTotalKb === 131072 && /X_CMCC_SysInfo\.CPUUsage$/.test(cm.insight.system.cpuSource ?? ''),
  `CMCC total ${cm.insight.system.memTotalKb} KiB, CPU dari ${cm.insight.system.cpuSource?.split('.').slice(-2).join('.')}`);
const db = new DatabaseSync(acs.dbFile);
const hw = devs[1];
const hid = `${hw.oui}-${hw.pc}-${hw.serial}`;
const inv = db.prepare("SELECT COUNT(*) n FROM invalid_param WHERE device_id = ? AND path LIKE '%DeviceInfo.%Status.%'").get(hid).n;
t.check(inv >= 2, `Huawei: path CPU/RAM standar yang tidak ada ditandai dari hasil discovery, tanpa GPV gagal (${inv})`);

// Upgrade profil v3 → v4: hanya GPN DeviceInfo.
const prof = JSON.parse(db.prepare('SELECT profile FROM collection WHERE device_id = ?').get(hid).profile).filter((p) => !/X_HW_(Cpu|Mem)Used/.test(p));
db.prepare('UPDATE collection SET profile = ?, profile_version = 3 WHERE device_id = ?').run(JSON.stringify(prof), hid);
db.prepare("DELETE FROM params WHERE device_id = ? AND path LIKE '%X_HW_%Used'").run(hid);
hw.V.set('InternetGatewayDevice.DeviceInfo.X_HW_CpuUsed', '55');
hw.log = [];
await inform(hw, acs.cwmp, '2 PERIODIC');
const gpn = hw.log.filter((m) => m === 'GetParameterNames').length;
const d2 = (await acs.get('/api/devices?limit=50')).items.find((d) => d.serial_number === 'HUAWEISYS');
t.check(gpn === 2 && d2.cpu_usage === 55, `upgrade v3→v5: ${gpn} GPN (DeviceInfo. + WANDevice.), CPU ${d2.cpu_usage}% — ${hw.log.length} RPC total`);

// Siklus rutin (leaf panas) ikut memperbarui CPU/RAM dalam 1 GPV.
db.prepare('UPDATE collection SET next_collect_at = 0, full_collect_at = ? WHERE device_id = ?').run(Date.now(), hid);
hw.V.set('InternetGatewayDevice.DeviceInfo.X_HW_CpuUsed', '71');
hw.log = [];
await inform(hw, acs.cwmp, '2 PERIODIC');
const d3 = (await acs.get('/api/devices?limit=50')).items.find((d) => d.serial_number === 'HUAWEISYS');
t.check(d3.cpu_usage === 71 && hw.log.length === 1, `siklus rutin: ${hw.log.length} GPV, CPU diperbarui ${d3.cpu_usage}%`);
t.done(acs);
