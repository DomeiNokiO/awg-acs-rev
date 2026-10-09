/**
 * Uji trafik live: Mbps dari selisih counter, wrap 32-bit, fallback counter,
 * dan urutan pasangan counter.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { LiveTraffic } from '../src/live.ts';
import { trafficCounters } from '../src/insight.ts';

const C = [{ label: 'a', rx: 'RX', tx: 'TX' }, { label: 'b', rx: 'RX2', tx: 'TX2' }];

test('Mbps dari selisih counter, termasuk wrap 32-bit', () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const l = new LiveTraffic();
  l.start('d', C, 60, 3000);
  l.onValues('d', { RX: String(2 ** 32 - 1_000_000), TX: '0' });
  mock.timers.tick(2000);
  // 25 MB diterima dalam 2 detik melewati batas 2^32 → 100 Mbps
  l.onValues('d', { RX: String(24_000_000), TX: '2500000' });
  const s = l.get('d')!;
  assert.equal(s.status, 'live');
  assert.equal(s.samples.length, 1);
  assert.equal(s.samples[0]!.down, 100);
  assert.equal(s.samples[0]!.up, 10);
  mock.timers.reset();
});

test('counter ditolak → pasangan berikutnya; habis → error', () => {
  const l = new LiveTraffic();
  l.start('d', C, 60, 3000);
  l.onFault('d');
  assert.equal(l.get('d')!.source!.label, 'b');
  l.onFault('d');
  assert.equal(l.get('d')!.status, 'error');
  assert.ok('error' in l.start('x', [], 60, 3000));
});

test('urutan counter: koneksi PPPoE utama dulu, yang terbukti ada didahulukan', () => {
  const b = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.';
  const P = (path: string, value: string) => ({ path, value });
  const c = trafficCounters([
    P(`${b}Username`, 'u'), P(`${b}ConnectionStatus`, 'Connected'),
    P('InternetGatewayDevice.WANDevice.1.WANCommonInterfaceConfig.TotalBytesReceived', '1'),
    P('InternetGatewayDevice.WANDevice.1.WANCommonInterfaceConfig.TotalBytesSent', '1'),
  ]);
  assert.match(c[0]!.rx, /WANCommonInterfaceConfig\.TotalBytesReceived$/); // terbukti ada
  assert.equal(c[1]!.rx, `${b}Stats.EthernetBytesReceived`);
  assert.equal(c.length, 3);
});
