/**
 * Uji Connection Request Digest (RFC 2617) dan pemisahan challenge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDigestChallenge, digestAuthorization } from '../src/connreq.ts';
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
