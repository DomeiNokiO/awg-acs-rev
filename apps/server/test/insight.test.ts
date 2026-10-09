/**
 * Uji insight.ts: redaman multi-vendor + satuan, PPPoE di instans mana pun,
 * WiFi, dan TR-181.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePower, extractOptical, extractWan, extractWlan, primaryPppoe, buildInsight, summaryFields,
} from '../src/insight.ts';
import { isInterestingLeaf, profileFromNodes } from '../src/profiler.ts';

const P = (path: string, value: string) => ({ path, value });

test('normalizePower: dBm, 0.1 µW, 0.001 dBm, LOS', () => {
  assert.equal(normalizePower('-21.34', 'rx').dbm, -21.34);
  assert.equal(normalizePower('-21.34 dBm', 'rx').dbm, -21.34);
  // 0.1 µW (CT-COM): 100 → 10 µW → -20 dBm
  assert.equal(normalizePower('100', 'rx').dbm, -20);
  // TR-181 OpticalSignalLevel 0.001 dBm
  assert.equal(normalizePower('-19500', 'rx').dbm, -19.5);
  assert.equal(normalizePower('-2134', 'rx').dbm, -21.34);
  // TX dBm positif tetap dBm
  assert.equal(normalizePower('2.31', 'tx').dbm, 2.31);
  // TX 0.1 µW: 20000 → 2 mW → 3.01 dBm
  assert.equal(normalizePower('20000', 'tx').dbm, 3.01);
  assert.equal(normalizePower('0', 'rx').los, true);
  assert.equal(normalizePower('', 'rx').dbm, null);
});

test('extractOptical: Huawei X_GponInterafceConfig, ZTE root CT-COM, Nokia, TR-181', () => {
  const hw = extractOptical([
    P('InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.RXPower', '-23.10'),
    P('InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.TXPower', '2.05'),
  ]);
  assert.equal(hw.rx, -23.1);
  assert.equal(hw.tx, 2.05);

  const zte = extractOptical([P('InternetGatewayDevice.X_CT-COM_GponInterfaceConfig.Stats.RxPower', '80')]);
  assert.equal(zte.rx, -20.97);

  const nokia = extractOptical([P('InternetGatewayDevice.X_ALU_OntOpticalParam.RXPower', '-18.2')]);
  assert.equal(nokia.rx, -18.2);

  const hw2 = extractOptical([P('InternetGatewayDevice.X_HW_DEBUG.AdminTR069.RxPower', '-24.5')]);
  assert.equal(hw2.rx, -24.5);

  const tr181 = extractOptical([P('Device.Optical.Interface.1.OpticalSignalLevel', '-21000')]);
  assert.equal(tr181.rx, -21);

  // Sinyal WiFi (Rssi) tidak boleh terbaca sebagai redaman.
  const wifi = extractOptical([P('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.AssociatedDevice.1.RXPower', '-50')]);
  assert.equal(wifi.rx, null);
});

test('extractWan: PPPoE di WANConnectionDevice.2 dengan VLAN Huawei', () => {
  const base = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.';
  const wan = extractWan([
    P(`${base}1.WANIPConnection.1.Name`, '1_TR069_R_VID_200'),
    P(`${base}1.WANIPConnection.1.ExternalIPAddress`, '10.10.1.5'),
    P(`${base}2.WANPPPConnection.1.Name`, '2_INTERNET_R_VID_100'),
    P(`${base}2.WANPPPConnection.1.Username`, 'pelanggan01@isp'),
    P(`${base}2.WANPPPConnection.1.ConnectionStatus`, 'Connected'),
    P(`${base}2.WANPPPConnection.1.ExternalIPAddress`, '100.64.3.9'),
    P(`${base}2.WANPPPConnection.1.X_HW_VLAN`, '100'),
    P(`${base}2.WANPPPConnection.1.X_HW_SERVICELIST`, 'INTERNET'),
  ]);
  assert.equal(wan.length, 2);
  const ppp = primaryPppoe(wan)!;
  assert.equal(ppp.base, `${base}2.WANPPPConnection.1.`);
  assert.equal(ppp.username, 'pelanggan01@isp');
  assert.equal(ppp.vlan, '100');
  assert.equal(ppp.serviceList, 'INTERNET');
});

test('extractWan: VLAN di level link (X_CT-COM_WANGponLinkConfig)', () => {
  const base = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.';
  const wan = extractWan([
    P(`${base}WANPPPConnection.1.Username`, 'u1'),
    P(`${base}X_CT-COM_WANGponLinkConfig.VLANIDMark`, '400'),
  ]);
  assert.equal(wan[0]!.vlan, '400');
  assert.equal(wan[0]!.vlanPath, `${base}X_CT-COM_WANGponLinkConfig.VLANIDMark`);
});

test('extractWan/extractWlan TR-181', () => {
  const params = [
    P('Device.PPP.Interface.1.Username', 'tr181user'),
    P('Device.PPP.Interface.1.ConnectionStatus', 'Connected'),
    P('Device.PPP.Interface.1.LowerLayers', 'Device.Ethernet.VLANTermination.4'),
    P('Device.Ethernet.VLANTermination.4.VLANID', '300'),
    P('Device.IP.Interface.2.LowerLayers', 'Device.PPP.Interface.1'),
    P('Device.IP.Interface.2.IPv4Address.1.IPAddress', '100.70.1.2'),
    P('Device.WiFi.SSID.1.SSID', 'Rumah'),
    P('Device.WiFi.SSID.1.LowerLayers', 'Device.WiFi.Radio.1'),
    P('Device.WiFi.Radio.1.OperatingFrequencyBand', '2.4GHz'),
    P('Device.WiFi.AccessPoint.1.SSIDReference', 'Device.WiFi.SSID.1'),
    P('Device.WiFi.AccessPoint.1.Security.KeyPassphrase', ''),
  ];
  const ins = buildInsight(params);
  assert.equal(ins.dataModel, 'TR-181');
  assert.equal(ins.wan[0]!.vlan, '300');
  assert.equal(ins.wan[0]!.externalIp, '100.70.1.2');
  assert.equal(ins.wlan[0]!.ssid, 'Rumah');
  assert.equal(ins.wlan[0]!.band, '2.4GHz');
  assert.deepEqual(ins.wlan[0]!.passphrasePaths, ['Device.WiFi.AccessPoint.1.Security.KeyPassphrase']);
  const sum = summaryFields(ins);
  assert.equal(sum['pppoe_user'], 'tr181user');
  assert.equal(sum['wan_ip'], '100.70.1.2');
});

test('extractWlan TR-098: band dan lokasi sandi', () => {
  const b = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.';
  const w = extractWlan([
    P(`${b}1.SSID`, 'Wifi-2G'), P(`${b}1.Channel`, '6'), P(`${b}1.KeyPassphrase`, 'rahasia123'),
    P(`${b}5.SSID`, 'Wifi-5G'), P(`${b}5.Channel`, '149'),
    P(`${b}5.PreSharedKey.1.KeyPassphrase`, ''),
  ]);
  assert.equal(w[0]!.band, '2.4GHz');
  assert.equal(w[0]!.hasPassphrase, true);
  assert.equal(w[1]!.index, 5);
  assert.equal(w[1]!.band, '5GHz');
  assert.deepEqual(w[1]!.passphrasePaths, [`${b}5.PreSharedKey.1.KeyPassphrase`]);
});

test('profiler: leaf menarik — PPPoE di instans mana pun, optik vendor, tabel besar dibuang', () => {
  const base = 'InternetGatewayDevice.WANDevice.1.';
  assert.ok(isInterestingLeaf(`${base}WANConnectionDevice.3.WANPPPConnection.1.Username`));
  assert.ok(isInterestingLeaf(`${base}WANConnectionDevice.3.WANPPPConnection.1.X_HW_VLAN`));
  assert.ok(isInterestingLeaf(`${base}WANConnectionDevice.2.X_CT-COM_WANGponLinkConfig.VLANIDMark`));
  assert.ok(isInterestingLeaf(`${base}X_ZTE-COM_WANPONInterfaceConfig.RXPower`));
  assert.ok(isInterestingLeaf(`${base}X_GponInterafceConfig.TXPower`));
  assert.ok(!isInterestingLeaf(`${base}WANConnectionDevice.1.WANPPPConnection.1.PortMapping.1.ExternalPort`));
  assert.ok(!isInterestingLeaf(`${base}WANConnectionDevice.1.WANPPPConnection.1.`));
  const prof = profileFromNodes([
    `${base}WANConnectionDevice.2.WANPPPConnection.1.Username`,
    `${base}WANConnectionDevice.2.WANPPPConnection.1.Stats.ErrorsSent`,
  ]);
  assert.deepEqual(prof, [`${base}WANConnectionDevice.2.WANPPPConnection.1.Username`]);
});
