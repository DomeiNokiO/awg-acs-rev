/**
 * Uji vendorwan.ts: skema VLAN per vendor (bukti vs tebakan), ServiceList,
 * binding port, parameter standar, dan pemilihan ConnectionType.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planVlan, planService, planBinding, planStandard, chooseConnectionType, detectFamily, type Evidence, type Family,
} from '../src/vendorwan.ts';

const W = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.';
const conn = `${W}2.WANPPPConnection.1.`;
const link = `${W}2.`;

/** Bukti tiruan: daftar path yang "ada" di perangkat. */
function ev(family: Family, paths: string[] = []): Evidence {
  const set = new Set(paths);
  return { exists: (p) => set.has(p), typeFor: (_p, fb) => fb, family };
}
const names = (fills: { name: string; value: string }[]) => fills.map((f) => `${f.name}=${f.value}`);

test('VLAN: bukti FiberHome link + koneksi → keduanya ditulis, bukan tebakan', () => {
  const e = ev('fiberhome', [`${link}X_FH_WANGponLinkConfig.VLANID`, `${link}X_FH_WANGponLinkConfig.Mode`, `${conn}X_FH_VLANID`]);
  const p = planVlan(e, conn, link, 200);
  assert.deepEqual(names(p.conn), ['X_FH_VLANID=200']);
  assert.deepEqual(names(p.link), ['X_FH_WANGponLinkConfig.Mode=2', 'X_FH_WANGponLinkConfig.VLANID=200']);
  assert.equal(p.guessed.length, 0);
});

test('VLAN: tanpa bukti → tebakan keluarga (ZTE, Huawei, CMCC, CT) dan ditandai', () => {
  assert.deepEqual(names(planVlan(ev('zte'), conn, link, 10).conn), ['X_ZTE-COM_VLANEnable=true', 'X_ZTE-COM_VLANID=10']);
  assert.deepEqual(names(planVlan(ev('huawei'), conn, link, 10).conn), ['X_HW_VLAN=10']);
  assert.deepEqual(names(planVlan(ev('cmcc'), conn, link, 10).conn), ['X_CMCC_VLANMode=2', 'X_CMCC_VLANIDMark=10']);
  const ct = planVlan(ev('ct'), conn, link, 10);
  assert.deepEqual(names(ct.link), ['X_CT-COM_WANGponLinkConfig.Enable=true', 'X_CT-COM_WANGponLinkConfig.Mode=2', 'X_CT-COM_WANGponLinkConfig.VLANIDMark=10']);
  assert.ok(ct.guessed.length > 0);
  assert.ok(planVlan(ev('nokia'), conn, link, 10).note);
});

test('VLAN: pendamping hanya ditulis bila ada buktinya', () => {
  const p = planVlan(ev('ct', [`${link}X_CMCC_WANGponLinkConfig.VLANIDMark`]), conn, link, 5);
  assert.deepEqual(names(p.link), ['X_CMCC_WANGponLinkConfig.VLANIDMark=5']);
});

test('ServiceList & binding port', () => {
  assert.deepEqual(planService(ev('huawei', [`${conn}X_HW_SERVICELIST`]), conn, 'INTERNET'),
    { fill: { name: 'X_HW_SERVICELIST', type: 'xsd:string', value: 'INTERNET' }, guessed: false });
  assert.equal(planService(ev('nokia'), conn, 'INTERNET').fill, null);
  const hw = planBinding(ev('huawei'), conn, [1, 3], [2]);
  assert.ok(names(hw.fills).includes('X_HW_LANBIND.Lan1Enable=true'));
  assert.ok(names(hw.fills).includes('X_HW_LANBIND.Lan2Enable=false'));
  assert.ok(names(hw.fills).includes('X_HW_LANBIND.SSID2Enable=true'));
  const ct = planBinding(ev('ct', [`${conn}X_CT-COM_LanInterface`]), conn, [1], [1]);
  assert.deepEqual(ct.fills[0]!.value,
    'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1,InternetGatewayDevice.LANDevice.1.WLANConfiguration.1');
  assert.equal(ct.guessed, false);
});

test('parameter standar: opsional hanya bila ada di perangkat', () => {
  const bare = planStandard(ev('zte'), conn, { kind: 'ppp', connectionType: 'IP_Routed', bridge: false, username: 'u', password: 'p' });
  assert.deepEqual(bare.map((f) => f.name), ['ConnectionType', 'Username', 'Password', 'NATEnabled']);
  const fh = planStandard(ev('fiberhome', [`${conn}TransportType`, `${conn}ConnectionTrigger`, `${conn}PPPAuthenticationProtocol`]), conn,
    { kind: 'ppp', connectionType: null, bridge: false, username: 'u', password: 'p' });
  assert.deepEqual(names(fh), ['TransportType=PPPoE', 'Username=u', 'Password=p', 'PPPAuthenticationProtocol=AUTO', 'ConnectionTrigger=AlwaysOn', 'NATEnabled=true']);
  const ip = planStandard(ev('huawei'), `${W}3.WANIPConnection.1.`, { kind: 'ip', connectionType: 'IP_Routed', bridge: false, staticIp: '10.0.0.2', gateway: '10.0.0.1' });
  assert.deepEqual(ip.map((f) => f.name), ['ConnectionType', 'AddressingType', 'NATEnabled', 'ExternalIPAddress', 'SubnetMask', 'DefaultGateway']);
});

test('ConnectionType mengikuti nilai yang dipakai perangkat', () => {
  assert.equal(chooseConnectionType('ppp', false, ['PPPoE_Routed']), 'PPPoE_Routed');
  assert.equal(chooseConnectionType('ppp', false, []), 'IP_Routed');
  assert.equal(chooseConnectionType('ppp', true, ['PPPoE_Routed']), 'PPPoE_Bridged');
  assert.equal(chooseConnectionType('ip', true, []), 'IP_Bridged');
  assert.equal(chooseConnectionType('ppp', false, ['PPPoE_Routed'], 'IP_Routed'), 'IP_Routed');
  assert.equal(chooseConnectionType('ppp', false, [], 'bad value!'), 'IP_Routed');
});

test('detectFamily: bukti path menang atas nama pabrikan (data lapangan 2026-10)', () => {
  // ZTE F660 V9.0.0P1T7 berfirmware China Mobile.
  assert.equal(detectFamily([`${conn}X_CMCC_VLANIDMark`, `${conn}X_CMCC_ServiceList`], 'ZTE', '001141'), 'cmcc');
  // FiberHome HG6145D2/HG6543C: VLAN standar `VLANID`, ServiceList vendor.
  assert.equal(detectFamily([`${conn}VLANID`, `${conn}X_FH_ServiceList`], 'FiberHome', '0019E0'), 'fiberhome');
  assert.equal(detectFamily([`${conn}X_ZTE-COM_VLANID`], 'ZTE', '001141'), 'zte');
  // Tanpa bukti → pabrikan / OUI.
  assert.equal(detectFamily([], 'ZTE', ''), 'zte');
  assert.equal(detectFamily([], 'CMCC', ''), 'cmcc');
  assert.equal(detectFamily([], 'VSOL', ''), 'ct');
});

test('detectFamily: F660 ORI vs F660 suntikan CMCC, firmware campuran → bukti terbanyak', () => {
  // ZTE F660 ORI: ekstensi ZTE di area WAN.
  assert.equal(detectFamily([`${conn}X_ZTE-COM_VLANID`, `${conn}X_ZTE-COM_ServiceList`], 'ZTE', '001141'), 'zte');
  // Campuran: 1 leaf ZTE vs 2 leaf CMCC → CMCC.
  assert.equal(detectFamily([`${conn}X_ZTE-COM_LanInterface`, `${conn}X_CMCC_VLANIDMark`, `${conn}X_CMCC_ServiceList`], 'ZTE', '001141'), 'cmcc');
  // Seri → keluarga pabrikan.
  assert.equal(detectFamily([`${conn}X_ZTE-COM_VLANID`, `${conn}X_CMCC_ServiceList`], 'ZTE', '001141'), 'zte');
  // Ekstensi di luar area WAN (mis. optik X_CMCC_GponInterfaceConfig) tidak menentukan keluarga WAN.
  assert.equal(detectFamily(['InternetGatewayDevice.WANDevice.1.X_CMCC_GponInterfaceConfig.RXPower'], 'ZTE', '001141'), 'zte');
});
