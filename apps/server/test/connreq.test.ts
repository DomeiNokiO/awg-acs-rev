/**
 * Uji Connection Request Digest (RFC 2617) dan pemisahan challenge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDigestChallenge, digestAuthorization, validateCrUrl, sendConnectionRequest } from '../src/connreq.ts';
import { hotPaths } from '../src/cwmp.ts';

test('Digest: contoh resmi RFC 2617 §3.5', () => {
  const ch = parseDigestChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"')!;
  assert.equal(ch.realm, 'testrealm@host.com');
  const h = digestAuthorization(ch, 'Mufasa', 'Circle Of Life', 'GET', '/dir/index.html', '0a4f113b', '00000001');
  assert.match(h, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(h, /qop=auth, nc=00000001, cnonce="0a4f113b"/);
  assert.match(h, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
});

test('Digest: challenge gabungan Basic + Digest dan tanpa qop', () => {
  const ch = parseDigestChallenge('Basic realm="x", Digest realm="CPE", nonce="n1"')!;
  assert.equal(ch.realm, 'CPE');
  assert.equal(ch.nonce, 'n1');
  assert.equal(parseDigestChallenge('Basic realm="x"'), null);
  assert.doesNotMatch(digestAuthorization(ch, 'u', 'p', 'GET', '/'), /qop=/);
});

test('hotPaths: hanya leaf yang berubah dari waktu ke waktu', () => {
  const b = 'InternetGatewayDevice.WANDevice.1.';
  const hot = hotPaths([
    `${b}X_FH_GponInterfaceConfig.RXPower`, `${b}WANConnectionDevice.2.WANPPPConnection.1.ConnectionStatus`,
    `${b}WANConnectionDevice.2.WANPPPConnection.1.ExternalIPAddress`, 'InternetGatewayDevice.DeviceInfo.UpTime',
    `${b}WANConnectionDevice.2.WANPPPConnection.1.Username`, `${b}WANConnectionDevice.2.WANPPPConnection.1.X_FH_VLANID`,
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
  ]);
  assert.equal(hot.length, 4);
  assert.ok(!hot.some((p) => /Username|VLANID|SSID/.test(p)));
});

test('validateCrUrl: port di luar rentang TCP (FiberHome RP2872) ditolak jelas', () => {
  const bad = validateCrUrl('http://11.171.0.4:1601009200/tr069');
  assert.ok('error' in bad && /65535/.test(bad.error), `harus error port: ${JSON.stringify(bad)}`);
  const bad2 = validateCrUrl('http://11.171.0.4:160100/tr069');
  assert.ok('error' in bad2, 'port 160100 > 65535 ditolak');
  const ok = validateCrUrl('http://11.171.0.4:7547/tr069');
  assert.ok('url' in ok && ok.url.port === '7547' && ok.url.hostname === '11.171.0.4');
  const ok2 = validateCrUrl('http://11.171.0.4/tr069'); // tanpa port
  assert.ok('url' in ok2);
  const bad3 = validateCrUrl('bukan url');
  assert.ok('error' in bad3);
});

test('sendConnectionRequest: URL port tak valid → reason malformed, tanpa koneksi', async () => {
  const r = await sendConnectionRequest('http://11.171.0.4:1601009200/tr069', '', '');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'malformed');
  assert.match(r.detail ?? '', /65535/);
});
