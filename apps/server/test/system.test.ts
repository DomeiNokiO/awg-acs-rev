/**
 * Uji CPU/RAM: standar TR-098/TR-181 dan pola leaf vendor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSystem } from '../src/insight.ts';
import { isInterestingLeaf } from '../src/profiler.ts';
import { hotPaths } from '../src/cwmp.ts';

const P = (path: string, value: string) => ({ path, value });
const D = 'InternetGatewayDevice.DeviceInfo.';

test('standar TR-098: ProcessStatus.CPUUsage + MemoryStatus Total/Free (KiB)', () => {
  const s = extractSystem([P(`${D}ProcessStatus.CPUUsage`, '17'), P(`${D}MemoryStatus.Total`, '262144'), P(`${D}MemoryStatus.Free`, '65536')]);
  assert.equal(s.cpu, 17);
  assert.equal(s.memTotalKb, 262144);
  assert.equal(s.memUsedPct, 75);
});

test('TR-181 Device.DeviceInfo', () => {
  const s = extractSystem([P('Device.DeviceInfo.ProcessStatus.CPUUsage', '5'), P('Device.DeviceInfo.MemoryStatus.Total', '524288'), P('Device.DeviceInfo.MemoryStatus.Free', '393216')]);
  assert.equal(s.cpu, 5);
  assert.equal(s.memUsedPct, 25);
});

test('vendor persen (gaya Huawei X_HW_CpuUsed / X_HW_MemUsed, "%")', () => {
  const s = extractSystem([P(`${D}X_HW_CpuUsed`, '33%'), P(`${D}X_HW_MemUsed`, '20')]);
  assert.equal(s.cpu, 33);
  assert.equal(s.memUsedPct, 20);
  assert.equal(s.memTotalKb, null);
});

test('vendor objek bersarang + satuan byte/MB, nama non-beban diabaikan', () => {
  const s = extractSystem([
    P(`${D}X_CMCC_SysInfo.CPUType`, 'MIPS'),
    P(`${D}X_CMCC_SysInfo.CPUFrequency`, '900'),
    P(`${D}X_CMCC_SysInfo.CPUUsage`, '42'),
    P(`${D}X_CMCC_SysInfo.MemoryTotal`, '268435456'), // byte
    P(`${D}X_CMCC_SysInfo.MemoryFree`, '134217728'),
  ]);
  assert.equal(s.cpu, 42);
  assert.equal(s.memTotalKb, 262144);
  assert.equal(s.memUsedPct, 50);
  const mb = extractSystem([P(`${D}X_ZTE-COM_MemTotal`, '256'), P(`${D}X_ZTE-COM_MemUsed`, '64')]);
  assert.equal(mb.memTotalKb, 262144);
  assert.equal(mb.memUsedPct, 25);
});

test('tidak ada data → null; profil & leaf panas mengenali CPU/RAM', () => {
  assert.deepEqual(extractSystem([P(`${D}UpTime`, '100')]).cpu, null);
  assert.ok(isInterestingLeaf(`${D}X_HW_CpuUsed`));
  assert.ok(isInterestingLeaf(`${D}X_CMCC_SysInfo.MemoryFree`));
  assert.ok(isInterestingLeaf(`${D}MemoryStatus.Total`));
  assert.ok(!isInterestingLeaf(`${D}ProcessStatus.Process.3.Size`));
  assert.deepEqual(hotPaths([`${D}ProcessStatus.CPUUsage`, `${D}MemoryStatus.Free`, `${D}MemoryStatus.Total`, `${D}X_HW_MemUsed`]),
    [`${D}ProcessStatus.CPUUsage`, `${D}MemoryStatus.Free`, `${D}X_HW_MemUsed`]);
});
