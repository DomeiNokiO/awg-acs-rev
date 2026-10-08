#!/usr/bin/env node
/**
 * Simulator ONT TR-069 — untuk menguji ACS tanpa perangkat asli.
 *
 * Kenapa perlu:
 *
 *  Menguji ACS langsung ke ONU asli berarti memanggil perangkat yang
 *  sedang dipakai pelanggan. Itu berisiko: sesi yang terputus, antrean
 *  yang hilang, atau (kalau ada bug) perintah yang tidak certainement
 *  dimaksud terkirim. Simulator ini membuat ACS bisa diuji berulang kali
 *  dengan perangkat yang kita kendalikan sepenuhnya.
 *
 * Yang disimulasikan:
 *   - Inform lengkap (DeviceId + ParameterList + Event)
 *   - GetParameterNames di root dan di subtree (untuk discovery)
 *   - GetParameterValues untuk path yang diminta (nilai realistis)
 *   - ManagementServer.ConnectionRequestURL yang benar-benar hidup, sehingga
 *     tombol "Hubungi" bisa diuji ujung ke ujung
 *   - SetParameterValues — dijawab, dan NOMOR INSTANS BARU ikut dikembalikan
 *     supaya AddObject bisa diuji
 *
 * Yang SENGAJA TIDAK ada:
 *   - Reboot / FactoryReset / Download. Simulator menolak RPC itu dengan
 *     Fault 9000 (Method not supported). Kalau ACS tanpa sengaja
 *     mengirimnya, ini terlihat langsung sebagai kegagalan, bukan diam-diam.
 *
 * Cara pakai:
 *   node scripts/sim-ont.mjs --url http://127.0.0.1:7547 --id SIM-0001 \
 *        --product-class HG6145D2 --oui 000AC2
 *   node scripts/sim-ont.mjs --watch 5        # Inform tiap 5 detik, selamanya
 */

const args = { url: 'http://127.0.0.1:7547', id: 'SIM-0001', oui: '000AC2', manufacturer: 'FiberHome', productClass: 'HG6145D2', crUrl: null, crUser: 'acsuser', crPass: 'acspass', watch: 0, count: 0, verbose: false, partial: false, reject: null, strictGpv: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--url') args.url = process.argv[++i];
  else if (a === '--id') args.id = process.argv[++i];
  else if (a === '--oui') args.oui = process.argv[++i];
  else if (a === '--manufacturer') args.manufacturer = process.argv[++i];
  else if (a === '--product-class') args.productClass = process.argv[++i];
  else if (a === '--cr-url') args.crUrl = process.argv[++i];
  else if (a === '--watch') args.watch = Number(process.argv[++i]);
  else if (a === '--count') args.count = Number(process.argv[++i]);
  else if (a === '--partial') args.partial = true;
  else if (a === '--reject') args.reject = process.argv[++i];
  else if (a === '--strict-gpv') args.strictGpv = true;
  else if (a === '--verbose') args.verbose = true;
}

const ATTRS =
  'xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/" ' +
  'xmlns:soap-enc="http://schemas.xmlsoap.org/soap/encoding/" ' +
  'xmlns:xsd="http://www.w3.org/2001/XMLSchema" ' +
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
  'xmlns:cwmp="urn:dslforum-org:cwmp-1-0"';

const envelope = (id, body) =>
  `<?xml version="1.0" encoding="UTF-8"?><soap-env:Envelope ${ATTRS}>` +
  `<soap-env:Header><cwmp:ID soap-env:mustUnderstand="1">${id}</cwmp:ID></soap-env:Header>` +
  `<soap-env:Body>${body}</soap-env:Body></soap-env:Envelope>`;

const esc = (v) => String(v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/** Peta nilai perangkat. Kunci = path TR-098; wildcard pakai `*`. */
const values = new Map();
function put(path, value) { values.set(path, String(value)); }
function get(path) {
  if (values.has(path)) return values.get(path);
  // wildcard: InternetGatewayDevice.WANDevice.*.WANCommonInterface.*.CurrUpstreamMaxBitRate
  const rx = new RegExp('^' + path.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^.]+') + '$');
  for (const [k, v] of values) if (rx.test(k)) return v;
  return undefined;
}

function seedValues(crUrl) {
  put('InternetGatewayDevice.DeviceInfo.Manufacturer', args.manufacturer);
  put('InternetGatewayDevice.DeviceInfo.ModelName', args.productClass);
  put('InternetGatewayDevice.DeviceInfo.ProductClass', args.productClass);
  put('InternetGatewayDevice.DeviceInfo.SerialNumber', args.id);
  put('InternetGatewayDevice.DeviceInfo.HardwareVersion', 'V1.0');
  put('InternetGatewayDevice.DeviceInfo.SoftwareVersion', 'V3R0192.10P20N20');
  put('InternetGatewayDevice.DeviceInfo.ProvisioningCode', 'SITGW6430000000');
  put('InternetGatewayDevice.DeviceInfo.FirstInformDate', '20260101120000');
  put('InternetGatewayDevice.ManagementServer.ConnectionRequestURL', crUrl);
  put('InternetGatewayDevice.ManagementServer.ConnectionRequestUsername', args.crUser);
  put('InternetGatewayDevice.ManagementServer.ConnectionRequestPassword', args.crPass);
  put('InternetGatewayDevice.ManagementServer.PeriodicInformInterval', '600');
  put('InternetGatewayDevice.ManagementServer.PeriodicInformTime', '20261007120000');
  put('InternetGatewayDevice.Time.LocalTime', '2026-10-07T10:00:00');

  // WAN + PPPoE: inilah yang harus muncul otomatis di UI
  const W = 'InternetGatewayDevice.WANDevice';
  const WCD = `${W}.1.WANConnectionDevice.1`;
  put(`${WCD}.WANConnectionType`, 'IP_Routed');
  put(`${WCD}.WANAddressingType`, 'Dynamic');
  put(`${WCD}.X_AVM_DE_WANConnectionType`, 'DSL');
  put(`${WCD}.X_AVM_DE_ConnectionMode`, 'Router');
  put(`${W}.1.WANCommonInterface.CurrUpstreamMaxBitRate`, '100000000');
  put(`${W}.1.WANCommonInterface.CurrDownstreamMaxBitRate`, '100000000');
  put(`${W}.1.WANCommonInterface.TotalBytesReceived`, '9876543210');
  put(`${W}.1.WANCommonInterface.TotalBytesSent`, '1234567890');
  put(`${W}.1.WANCommonInterface.TotalPacketsReceived`, '9988776');
  put(`${W}.1.WANCommonInterface.TotalPacketsSent`, '8877665');
  put(`${W}.1.WANCommonInterface.CurrUpstreamPacketsLost`, '12');
  put(`${W}.1.WANCommonInterface.CurrDownstreamPacketsLost`, '7');

  const PPP = `${WCD}.WANPPPConnection.1`;
  put(`${PPP}.Enable`, 'true');
  put(`${PPP}.ConnectionStatus`, 'Connected');
  put(`${PPP}.LastConnectionError`, 'NONE');
  put(`${PPP}.ExternalIPAddress`, '100.100.10.24');
  put(`${PPP}.X_AVM_DE_UserName`, 'pppoe@contoh');
  put(`${PPP}.X_AVM_DE_Password`, 'rahasia-pppoe');
  put(`${PPP}.X_AVM_DE_VLANID`, '100');
  put(`${PPP}.X_AVM_DE_Encapsulation`, 'VLAN');
  put(`${PPP}.X_AVM_DE_MTU`, '1492');
  put(`${PPP}.X_AVM_DE_ConnectionStatus`, 'Connected');
  put(`${PPP}.X_AVM_DE_PPPoEPhaseState`, 'Session');
  put(`${PPP}.X_AVM_DE_PPPoEPhasePhaseChangeTime`, '1735689600');
  put(`${PPP}.X_AVM_DE_Speed`, '100000000');
  put(`${PPP}.X_AVM_DE_UpstreamMaxBitRate`, '100000000');

  const IP = `${WCD}.WANIPConnection.1`;
  put(`${IP}.ExternalIPAddress`, '100.100.10.24');
  put(`${IP}.X_AVM_DE_DefaultConnection`, 'true');
  put(`${IP}.X_AVM_DE_DhcpEnabled`, 'false');

  const ATT = `${WCD}.WANAddressing.1`;
  put(`${ATT}.X_AVM_DE_ConnectionType`, 'DHCP');
  put(`${ATT}.Address`, '100.100.10.24');
  put(`${ATT}.X_AVM_DE_SubnetMask`, '255.255.255.0');
  put(`${ATT}.X_AVM_DE_Gateway`, '100.100.10.1');
  put(`${ATT}.X_AVM_DE_DNSServers`, '8.8.8.8 8.8.4.4');

  // LAN: VLAN
  const LAN = 'InternetGatewayDevice.LANDevice';
  put(`${LAN}.1.LANDeviceConnection.1.EthernetBinding.1.X_AVM_DE_VLANID`, '7');
  put(`${LAN}.1.LANDeviceConnection.1.X_AVM_DE_SSID`, 'WiFi-ONT');
  put(`${LAN}.1.LANDeviceConnection.1.X_AVM_DE_LANIfIndex`, '1');
}

/** GetParameterNames: kembalikan anak langsung dari path yang ditanyakan. */
const TREE = {
  'InternetGatewayDevice.': ['WANDevice.', 'LANDevice.', 'DeviceInfo.', 'ManagementServer.', 'Time.', 'PPP.'],
  'InternetGatewayDevice.WANDevice.': ['1.'],
  'InternetGatewayDevice.WANDevice.1.': ['WANCommonInterface.1.', 'WANConnectionDevice.1.'],
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANAddressing.1.': [
    'X_AVM_DE_ConnectionType', 'Address', 'X_AVM_DE_SubnetMask', 'X_AVM_DE_Gateway', 'X_AVM_DE_DNSServers',
  ],
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.': [
    'ExternalIPAddress', 'X_AVM_DE_DefaultConnection', 'X_AVM_DE_DhcpEnabled',
  ],
  'InternetGatewayDevice.WANDevice.1.WANCommonInterface.1.': [
    'CurrUpstreamMaxBitRate', 'CurrDownstreamMaxBitRate', 'TotalBytesReceived', 'TotalBytesSent',
    'TotalPacketsReceived', 'TotalPacketsSent', 'CurrUpstreamPacketsLost', 'CurrDownstreamPacketsLost',
  ],
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.': ['WANPPPConnection.1.', 'WANIPConnection.1.', 'WANCommonInterface.1.', 'WANAddressing.1.'],
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.': ['WANPPPConnection.1.', 'WANIPConnection.1.', 'WANCommonInterface.1.', 'WANAddressing.1.'],
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.': [
    'Enable', 'ConnectionStatus', 'LastConnectionError', 'ExternalIPAddress',
    'X_AVM_DE_UserName', 'X_AVM_DE_VLANID', 'X_AVM_DE_ConnectionStatus', 'X_AVM_DE_Speed',
  ],
  'InternetGatewayDevice.LANDevice.': ['LANDeviceConnection.1.'],
  'InternetGatewayDevice.LANDevice.1.': ['LANDeviceConnection.1.'],
  'InternetGatewayDevice.LANDevice.1.LANDeviceConnection.1.': ['EthernetBinding.1.', 'X_AVM_DE_SSID'],
  'InternetGatewayDevice.ManagementServer.': [
    'ConnectionRequestURL', 'ConnectionRequestUsername', 'ConnectionRequestPassword',
    'PeriodicInformInterval', 'PeriodicInformTime', 'ParameterKey',
  ],
  'InternetGatewayDevice.DeviceInfo.': [
    'Manufacturer', 'ModelName', 'ProductClass', 'SerialNumber',
    'HardwareVersion', 'SoftwareVersion', 'ProvisioningCode', 'FirstInformDate',
  ],
  'InternetGatewayDevice.Time.': ['LocalTime', 'TotalTime', 'TimeZone'],
  'InternetGatewayDevice.PPP.': ['1.'],
};

function handleGetParameterNames(path, nextLevel) {
  // Perangkat TR-069 partial (FiberHome HG6145D2, HG6543C) menjawab SOAP
  // Fault 9005 untuk path yang tidak berlaku bagi mereka, bukan daftar
  // kosong. ACS wajib memperlakukan dua hal ini berbeda: daftar kosong
  // berarti "coba yang lebih dalam", fault berarti "path ini tidak berlaku
  // untuk perangkat ini" — jadi dicek sebelum melihat TREE, bukan sesudah.
  if (rejectedPaths().has(path)) return fault9005();

  const kids = TREE[path];
  if (!kids) {
    return envelope('1', '<cwmp:GetParameterNamesResponse><ParameterList/></cwmp:GetParameterNamesResponse>');
  }
  // When asked for a childless leaf path (e.g. ...WANCommonInterface.1.), we
  // still want the ACS to be able to read the values. So a numeric parent
  // returns its own members.
  const nodes = kids.map((k) => {
    const full = path + k;
    const isLeaf = !k.endsWith('.');
    return `<ParameterInfoStruct><Name>${esc(full)}</Name>` +
      `<Writable>${isLeaf ? 'true' : 'false'}</Writable></ParameterInfoStruct>`;
  }).join('');
  void nextLevel;
  return envelope('1', `<cwmp:GetParameterNamesResponse><ParameterList>${nodes}</ParameterList></cwmp:GetParameterNamesResponse>`);
}

function handleGetParameterValues(paths) {
  // Mode strict: seperti FiberHome HG6145D2 asli — SATU path yang tidak
  // dikenal membatalkan seluruh batch dengan SOAP Fault 9005, bukan
  // memberi tahu path mana yang bermasalah. Inilah yang memaksa ACS
  // memecah batch (split-on-fault) untuk menemukan path jahatnya.
  if (args.strictGpv) {
    const unknown = paths.find((pth) => get(pth) === undefined);
    if (unknown) return fault9005();
  }
  const list = paths.map((p) => {
    const v = get(p);
    if (v === undefined) {
      return `<ParameterValueStruct><Name>${esc(p)}</Name>` +
        `<Fault><FaultCode>9018</FaultCode><FaultString>Parameter name not found</FaultString></Fault></ParameterValueStruct>`;
    }
    return `<ParameterValueStruct><Name>${esc(p)}</Name><Value xsi:type="xsd:string">${esc(v)}</Value></ParameterValueStruct>`;
  }).join('');
  return envelope('1', `<cwmp:GetParameterValuesResponse><ParameterList>${list}</ParameterList></cwmp:GetParameterValuesResponse>`);
}

/** Parse ParameterNames from ACS's GetParameterValues XML. */
function parseRequestedPaths(xml) {
  const out = [];
  // Bentuk standar: satu blok <ParameterNames arrayType=...> berisi
  // elemen <string>. Bentuk lama (beberapa <ParameterNames> berisi teks
  // langsung) tetap didukung supaya simulator bisa menguji dua-duanya.
  const block = /<ParameterNames[^>]*>([\s\S]*?)<\/ParameterNames>/.exec(xml);
  if (block) {
    const strings = block[1].match(/<string>([^<]*)<\/string>/g);
    if (strings) return strings.map((s) => s.replace(/<\/?string>/g, ''));
    if (block[1].trim() && !block[1].includes('<')) return [block[1].trim()];
  }
  const re = /<ParameterNames>([^<]*)<\/ParameterNames>/g;
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
function parseRequestedName(xml) {
  // TR-069: argumen GetParameterNames bernama ParameterPath.
  const m = /<ParameterPath>([^<]*)<\/ParameterPath>/.exec(xml) ?? /<ParameterName>([^<]*)<\/ParameterName>/.exec(xml);
  return m ? m[1] : 'InternetGatewayDevice.';
}

let cookie = '';
let crUrl = args.crUrl;
if (!crUrl) {
  // For self-testing, run a tiny ConnectionRequest listener so the URL is real.
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    res.writeHead(200); res.end('ok');
    log(`CR diterima: ${req.method} ${req.url} auth=${req.headers.authorization ? 'ada' : 'tidak'}`);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  crUrl = `http://127.0.0.1:${srv.address().port}/`;
  log(`ConnectionRequest aktif di ${crUrl}`);
}

seedValues(crUrl);

async function post(body, id) {
  const res = await fetch(args.url, {
    method: 'POST',
    headers: { 'content-type': 'text/xml; charset=utf-8', ...(cookie ? { cookie } : {}) },
    body,
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const pair = c.split(';')[0];
    if (pair.startsWith('acs_session=')) cookie = pair;
  }
  const text = await res.text();
  log(`← HTTP ${res.status} (${text.length} B)`);
  if (args.verbose && text) log('  ' + text.replace(/>\s+</g, '><').slice(0, args.verbose === 'full' ? text.length : 4000));
  return { status: res.status, text };
}

function log(msg) { console.log(`[sim:${args.id}] ${msg}`); }

/** Answers one ACS->CPE RPC and returns whether we should send it. */
/**
 * Path yang perangkat ini tolak dengan Fault 9005.
 *
 * Sengaja dihitung saat dipakai, bukan sekali saat modul dimuat: args baru
 * lengkap setelah baris parse dieksekusi, sehingga set yang dibangun lebih
 * awal akan selalu kosong dan pengujian penolakan jadi tidak berarti.
 */
function rejectedPaths() {
  if (args.reject !== null) {
    return new Set(args.reject.split(',').map((s) => s.trim()).filter(Boolean));
  }
  return new Set(args.partial ? REJECT_DEFAULT : []);
}

const REJECT_DEFAULT = [
  'InternetGatewayDevice.',
  'InternetGatewayDevice.WANDevice.1.',
];

function fault9005() {
  return envelope('1',
    '<soap-env:Fault><faultcode>Client</faultcode><faultstring>CWMP Fault</faultstring>' +
    '<detail><cwmp:Fault><FaultCode>9005</FaultCode>' +
    '<FaultString>Invalid parameter name</FaultString></cwmp:Fault></detail></soap-env:Fault>');
}

function respondToRpc(acsText) {
  const mMethod = /<cwmp:([A-Za-z]+)>/.exec(acsText);
  if (!mMethod) return { handled: false };
  const method = mMethod[1];

  if (method === 'GetParameterNames') {
    return { handled: true, reply: handleGetParameterNames(parseRequestedName(acsText), /<NextLevel>true</.test(acsText)) };
  }
  if (method === 'GetParameterValues') {
    return { handled: true, reply: handleGetParameterValues(parseRequestedPaths(acsText)) };
  }
  if (method === 'SetParameterValues') {
    // Confirm the write, but do not actually mutate anything: the point is
    // to confirm the ACS→CPE direction works without side effects.
    return { handled: true, reply: envelope('1', '<cwmp:SetParameterValuesResponse/>') };
  }
  if (method === 'AddObject') {
    // Pretend a new instance number 3 was allocated.
    return { handled: true, reply: envelope('1', '<cwmp:AddObjectResponse><InstanceNumber>3</InstanceNumber><Status>0</Status></cwmp:AddObjectResponse>') };
  }
  if (method === 'DeleteObject') {
    return { handled: true, reply: envelope('1', '<cwmp:DeleteObjectResponse><Status>0</Status></cwmp:DeleteObjectResponse>') };
  }
  if (method === 'Reboot' || method === 'FactoryReset' || method === 'Download') {
    // Deliberately unsupported so an accidental destructive RPC shows up.
    log(`⚠ ACS mengirim ${method} — simulator menolak (Fault 9000)`);
    return {
      handled: true,
      reply: envelope('1', '<soap-env:Fault><faultcode>Client</faultcode><faultstring>CWMP Fault</faultstring>' +
        '<detail><cwmp:Fault><FaultCode>9000</FaultCode><FaultString>Method not supported by simulator</FaultString></cwmp:Fault></detail></soap-env:Fault>'),
    };
  }
  return { handled: true, reply: envelope('1', `<cwmp:${method}Response/>`) };
}

let counter = 0;

/**
 * Satu sesi CWMP: ACS mengirim satu RPC per HTTP POST.
 *
 * Aturan besarnya sederhana — kalau ACS mengirim RPC, jawab dengan
 * Response yang cocok; kalau ACS mengirim envelope kosong, itu berarti
 * sesi selesai.
 */
/**
 * Jalankan satu sesi CWMP.
 *
 * Aturan protocol: setelah CSE (bukan CPE) mengirim sesuatu, ACS membalas
 * dengan RPC berikutnya ATAU envelope kosong. Jadi kita selalu menjawab
 * pesan ACS TERAKHIR — tidak pernah menebak harus POST kosong atau tidak.
 * Loop ini karena itu mengikuti "apa yang ACS baru kirim", bukan-tebakan.
 */
async function runSession(id, first) {
  let last = first;
  for (let step = 0; step < 60; step++) {
    const rpc = /<cwmp:([A-Za-z]+)[\s>]/.exec(last);
    if (!rpc) return step;
    const method = rpc[1];
    if (method.endsWith('Response')) {
      // Bukan untuk kita jawab — biarkan ACS yang memutuskan.
      last = '';
      continue;
    }
    const out = respondToRpc(last);
    if (!out.reply) return step;
    log(`  ACS → ${method}`);
    const sent = await post(out.reply, id);
    last = sent.text;
  }
  return 60;
}

async function informOnce() {
  counter++;
  const id = String(counter);
  const body = envelope(id,
    '<cwmp:Inform>' +
    '<cwmp:ParameterList>' +
    '<soap-enc:string>InternetGatewayDevice.DeviceInfo.HardwareVersion</soap-enc:string>' +
    '<soap-enc:string>InternetGatewayDevice.DeviceInfo.SoftwareVersion</soap-enc:string>' +
    '</cwmp:ParameterList>' +
    `<cwmp:DeviceId><cwmp:Manufacturer>${esc(args.manufacturer)}</cwmp:Manufacturer>` +
    `<cwmp:OUI>${esc(args.oui)}</cwmp:OUI><cwmp:ProductClass>${esc(args.productClass)}</cwmp:ProductClass>` +
    `<cwmp:SerialNumber>${esc(args.id)}</cwmp:SerialNumber></cwmp:DeviceId>` +
    '<cwmp:Event soap-enc:arrayType="soap-enc:string[1]"><soap-enc:string>2 PERIODIC</soap-enc:string></cwmp:Event>' +
    '<cwmp:MaxEnvelopes>1</cwmp:MaxEnvelopes>' +
    '<cwmp:CurrentTime>2026-10-07T10:00:00Z</cwmp:CurrentTime>' +
    '<cwmp:RetryCount>0</cwmp:RetryCount>' +
    '</cwmp:Inform>');
  log('→ Inform');
  const r = await post(body, id);
  if (r.status !== 200) return;
  if (!/<cwmp:InformResponse/.test(r.text)) {
    log('⚠ balasan bukan InformResponse — ACS menolak sesi');
    return;
  }
  // Balasan Inform sudah diterima. Lanjut ke runbook sesi: ACS yang
  // memutuskan RPC berikutnya, dan kita menjawab setiap pesan yang masuk.
  const steps = await runSession(id, r.text);
  log(`sesi selesai (${steps} RPC)`);
}

log(`mengirim ke ${args.url} sebagai ${args.oui}-${args.productClass}-${args.id}`);
await informOnce();

// Server ConnectionRequest yang kita buat menahan event loop. Untuk mode
// sekali jalan kita keluarkan secara eksplisit; kalau tidak, skrip tidak
// pernah selesai dan CI/menjalankan dari shell ikut menggantung.
if (args.watch <= 0) {
  if (args.count > 0) {
    // Mode banyak siklus untuk pengujian otomatis: satu proses, banyak
    // Inform. Ini jauh lebih cepat daripada memanggil skrip 20 kali, dan
    // menjaga satu cookie sesi sehingga skenario jadi lebih realistis.
    for (let i = 1; i < args.count; i++) {
      await informOnce();
    }
  }
  process.exit(0);
}

if (args.watch > 0) {
  log(`mode watch: Inform tiap ${args.watch} detik (Ctrl+C untuk berhenti)`);
  setInterval(() => { informOnce().catch((e) => log(`error: ${e.message}`)); }, args.watch * 1000);
}
