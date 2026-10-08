/**
 * Uji state machine CWMP dengan alur sesi TR-069 yang nyata.
 *
 * Skenarionya meniru perangkat sungguhan: Inform -> InformResponse ->
 * CPE POST kosong -> ACS kirim GetParameterValues -> CPE balas nilai ->
 * ACS kosong -> CPE kosong -> selesai.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CwmpSession, TaskQueue, buildGetParameterValues, buildSetParameterValues,
  type Rpc, type RpcResult, type DeviceIdentity,
} from '../src/index.ts';

const INFORM = `<?xml version="1.0" encoding="UTF-8"?>
<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:soap-enc="http://schemas.xmlsoap.org/soap/encoding/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
 <soap-env:Header><cwmp:ID soap-env:mustUnderstand="1">cwmp-init-1</cwmp:ID></soap-env:Header>
 <soap-env:Body><cwmp:Inform>
  <cwmp:ParameterList>
    <soap-enc:string>InternetGatewayDevice.DeviceInfo.HardwareVersion</soap-enc:string>
    <soap-enc:string>InternetGatewayDevice.DeviceInfo.SoftwareVersion</soap-enc:string>
  </cwmp:ParameterList>
  <cwmp:DeviceId>
    <cwmp:Manufacturer>ZTE</cwmp:Manufacturer>
    <cwmp:OUI>YUV802</cwmp:OUI>
    <cwmp:ProductClass>F660</cwmp:ProductClass>
    <cwmp:SerialNumber>ZTEG12345678</cwmp:SerialNumber>
  </cwmp:DeviceId>
  <cwmp:Event soap-enc:arrayType="soap-enc:string[1]"><soap-enc:string>2 PERIODIC</soap-enc:string></cwmp:Event>
  <cwmp:MaxEnvelopes>1</cwmp:MaxEnvelopes>
  <cwmp:CurrentTime>2026-10-06T09:00:00Z</cwmp:CurrentTime>
  <cwmp:RetryCount>0</cwmp:RetryCount>
 </cwmp:Inform></soap-env:Body>
</soap-env:Envelope>`;

function makeSession(rpcQueue: Rpc[] = []) {
  const results: RpcResult[] = [];
  const queue = [...rpcQueue];
  let ident: DeviceIdentity | null = null;
  const session = new CwmpSession({
    dequeue(device) {
      ident = device;
      return queue.shift() ?? null;
    },
    record(_device, r) { results.push(r); },
  });
  return { session, results, getIdent: () => ident };
}

test('Inform dibalas InformResponse dan identitas terbaca', () => {
  const { session, getIdent } = makeSession();
  const out = session.handle(INFORM);
  assert.equal(out.status, 200);
  assert.equal(out.done, false);
  assert.match(out.responseXml, /InformResponse/);
  assert.equal(out.inform?.identity.serialNumber, 'ZTEG12345678');
  assert.equal(out.inform?.identity.oui, 'YUV802');
  assert.deepEqual(out.inform?.events, ['2 PERIODIC']);
  // Sesuai TR-069: Inform hanya dibalas InformResponse. RPC menyusul di
  // POST berikutnya, jadi dequeue memang belum boleh dipanggil di sini.
  assert.equal(getIdent(), null, 'dequeue tidak boleh dipanggil saat Inform');
  assert.match(out.responseXml, /<cwmp:InformResponse>/);
  // Respons harus meng-echo ID request yang diresponsnya (korelasi SOAP).
  // Terverifikasi terhadap GenieACS 1.2.16 asli: Inform ber-ID
  // "UNIQ-ID-XYZ-42" dibalas InformResponse ber-ID "UNIQ-ID-XYZ-42".
  // ID digit hanya dipakai saat ACS mengirim request miliknya sendiri.
  assert.match(out.responseXml, /<cwmp:ID soap-env:mustUnderstand="1">cwmp-init-1<\/cwmp:ID>/);
});

test('POST kosong setelah Inform memicu RPC dari antrean', () => {
  const gpv = buildGetParameterValues('t1', [
    'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
  ]);
  const { session } = makeSession([gpv]);
  session.handle(INFORM);
  const out = session.handle('');
  assert.match(out.responseXml, /GetParameterValues/);
  assert.match(out.responseXml, /SoftwareVersion/);
  assert.match(out.responseXml, /ExternalIPAddress/);
  assert.equal(out.done, false);
});

test('balasan GetParameterValues dicatat, lalu sesi ditutup bersih', () => {
  const gpv = buildGetParameterValues('t1', ['InternetGatewayDevice.DeviceInfo.SoftwareVersion']);
  const { session, results } = makeSession([gpv]);
  session.handle(INFORM);
  session.handle('');

  const resp = `<?xml version="1.0" encoding="UTF-8"?>
  <soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
   <soap-env:Header><cwmp:ID soap-env:mustUnderstand="1">1</cwmp:ID></soap-env:Header>
   <soap-env:Body><cwmp:GetParameterValuesResponse>
     <ParameterList>
       <ParameterValueStruct>
         <Name>InternetGatewayDevice.DeviceInfo.SoftwareVersion</Name>
         <Value xsi:type="xsd:string">V9.0.10P1N12A</Value>
       </ParameterValueStruct>
     </ParameterList>
   </cwmp:GetParameterValuesResponse></soap-env:Body>
  </soap-env:Envelope>`;

  const out = session.handle(resp);
  assert.equal(results.length, 1, 'harus ada satu hasil tercatat');
  const r = results[0]!;
  assert.equal(r.kind, 'gpv');
  if (r.kind === 'gpv') {
    assert.equal(r.values['InternetGatewayDevice.DeviceInfo.SoftwareVersion'], 'V9.0.10P1N12A');
    assert.equal(r.errors.length, 0);
  }

  // antrean habis -> envelope kosong pertama
  const p1 = session.handle('');
  assert.match(p1.responseXml, /soap-env:Body\/>|<soap-env:Body><\/soap-env:Body>/);
  // kedua kosong -> selesai
  const p2 = session.handle('');
  assert.equal(p2.done, true, 'sesi harus selesai setelah dua kosong berturut-turut');
});

test('SetParameterValues dari antrean terkirim dengan tipe yang benar', () => {
  const spv = buildSetParameterValues('t2', [
    { name: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', type: 'xsd:string', value: 'ISP-<Baru>' },
    { name: 'InternetGatewayDevice.ManagementServer.PeriodicInformInterval', type: 'xsd:unsignedInt', value: '300' },
    { name: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable', type: 'xsd:boolean', value: 'true' },
  ], 'cfg-1');

  const { session } = makeSession([spv]);
  session.handle(INFORM);
  const out = session.handle('');

  assert.match(out.responseXml, /SetParameterValues/);
  assert.match(out.responseXml, /xsi:type="xsd:unsignedInt"/);
  assert.match(out.responseXml, /xsi:type="xsd:boolean"/);
  // karakter XML berbahaya harus ter-escape, bukan masuk mentah
  assert.match(out.responseXml, /ISP-&lt;Baru&gt;/);
  assert.doesNotMatch(out.responseXml, /ISP-<Baru>/);
  assert.match(out.responseXml, /<ParameterKey>cfg-1<\/ParameterKey>/);
});

test('Fault dari CPE diteruskan sebagai hasil, bukan membuat sesi crash', () => {
  const spv = buildSetParameterValues('t3', [
    { name: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.NATEnabled', type: 'xsd:boolean', value: 'true' },
  ]);
  const { session, results } = makeSession([spv]);
  session.handle(INFORM);
  session.handle('');

  const fault = `<?xml version="1.0" encoding="UTF-8"?>
  <soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
   <soap-env:Header><cwmp:ID soap-env:mustUnderstand="1">1</cwmp:ID></soap-env:Header>
   <soap-env:Body><soap-env:Fault>
     <faultcode>Client</faultcode>
     <faultstring>Server Fault</faultstring>
     <detail><cwmp:Fault>
       <FaultCode>9007</FaultCode>
       <FaultString>Invalid parameter value</FaultString>
     </cwmp:Fault></detail>
   </soap-env:Fault></soap-env:Body>
  </soap-env:Envelope>`;

  const out = session.handle(fault);
  assert.equal(results.length, 1);
  const r = results[0]!;
  assert.equal(r.kind, 'fault');
  if (r.kind === 'fault') {
    assert.equal(r.code, 9007);
    // Fault sekarang menyebut RPC mana yang ditolak. Tanpa itu satu
    // fault 9005 tidak bisa ditelusuri ke path penyebabnya.
    assert.match(r.message, /^Invalid parameter value/);
    assert.match(r.message, /SetParameterValues/);
  }
  assert.equal(out.status, 200, 'fault tidak boleh mengubah status HTTP');
});

test('Inform tanpa SerialNumber ditolak dengan fault 9015', () => {
  const bad = INFORM.replace('<cwmp:SerialNumber>ZTEG12345678</cwmp:SerialNumber>', '<cwmp:SerialNumber></cwmp:SerialNumber>');
  const { session } = makeSession();
  const out = session.handle(bad);
  assert.equal(out.status, 400);
  assert.match(out.responseXml, /<FaultCode>9015<\/FaultCode>/);
  assert.equal(out.done, true);
});

test('RPC sebelum Inform ditolak, sesi tidak dibuka liar', () => {
  const { session } = makeSession();
  const out = session.handle(`<?xml version="1.0"?><soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0"><soap-env:Header><cwmp:ID>1</cwmp:ID></soap-env:Header><soap-env:Body><cwmp:GetParameterValuesResponse><ParameterList/></cwmp:GetParameterValuesResponse></soap-env:Body></soap-env:Envelope>`);
  assert.equal(out.status, 500);
  assert.equal(out.done, true);
});

test('TaskQueue: urutan FIFO, kadaluarsa, dan TTL', () => {
  const q = new TaskQueue(50);
  q.enqueue('dev1', buildGetParameterValues('a', ['x']));
  q.enqueue('dev1', buildGetParameterValues('b', ['y']));
  q.enqueue('dev2', buildGetParameterValues('c', ['z']));

  assert.equal(q.size(), 3);
  assert.equal(q.size('dev1'), 2);
  assert.equal(q.pending('dev1').length, 2);

  const first = q.dequeue('dev1');
  assert.equal(first?.rpc.key, 'a');
  const second = q.dequeue('dev1');
  assert.equal(second?.rpc.key, 'b');
  assert.equal(q.dequeue('dev1'), null, 'antrean dev1 harus kosong');
  assert.equal(q.dequeue('dev2')?.rpc.key, 'c', 'antrean dev2 tidak boleh ikut terkonsumsi');
});

test('TaskQueue: task kedaluwarsa tidak dikirim ke perangkat', async () => {
  const q = new TaskQueue(10); // TTL 10 ms
  q.enqueue('dev', buildGetParameterValues('expired', ['x']));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(q.dequeue('dev'), null, 'task lewat TTL harus dibuang');
  assert.equal(q.size(), 0);
});
