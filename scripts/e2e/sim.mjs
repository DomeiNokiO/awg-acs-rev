/**
 * Simulator ONU TR-069 "ketat" untuk uji end-to-end AWG-ACS.
 *
 * Profil: zte, huawei, fiberhome (HG6543C), cmcc (GM220-S). Perilaku yang
 * ditiru dari firmware nyata:
 *  - GPV dengan satu path tak dikenal → Fault 9005 untuk SELURUH batch;
 *  - elemen RPC non-standar (<CommandKey> di GPV, tanpa <ParameterPath> di
 *    GPN) → Fault 9003;
 *  - opsi: tidak menyimpan cookie (noCookie), koneksi TCP baru tiap request
 *    (freshConn), menolak GPN NextLevel=false (rejectDeep), namespace
 *    cwmp-1-2 yang wajib dicocokkan (ns, strictNs), memutus sesi bila ACS
 *    mengirim amplop SOAP kosong alih-alih HTTP 204 (strictEnd), slot WAN
 *    kosong buatan OLT (emptySlot), tanpa data CPU/RAM (sys: false),
 *    sandi PPPoE/WiFi awal (pppPass, wifiPass), sandi selalu dibaca kosong
 *    (hideSecrets), WAN FiberHome tanpa binding X_FH_LanInterface (fhUnbound).
 */
import http from 'node:http';

const FH_BIND_ALL = [1, 2, 3, 4].map((n) => `InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.${n}`)
  .concat('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1').join(',');

export function makeDevice(vendor, serial, opts = {}) {
  const V = new Map();
  const extraObjects = new Set();
  const objects = new Set();
  const put = (k, v) => V.set(k, String(v));
  const P = 'InternetGatewayDevice.';
  const W = `${P}WANDevice.1.`;
  let [oui, pc, man] = {
    zte: ['001141', 'F670L', 'ZTE'],
    huawei: ['00E0FC', 'HG8245H5', 'Huawei Technologies Co., Ltd'],
    fiberhome: ['0019E0', 'HG6543C', 'FiberHome'],
    cmcc: ['A0F3E4', 'GM220-S', 'CMCC'],
  }[vendor];
  // identity: [oui, productClass, manufacturer] — firmware vendor X di hardware
  // merek lain (mis. firmware CMCC di ZTE F660).
  if (opts.identity) [oui, pc, man] = opts.identity;
  put(`${P}DeviceInfo.Manufacturer`, man);
  put(`${P}DeviceInfo.ModelName`, pc);
  put(`${P}DeviceInfo.SerialNumber`, serial);
  put(`${P}DeviceInfo.SoftwareVersion`, vendor === 'fiberhome' ? 'RP2872' : 'V1.0');
  put(`${P}DeviceInfo.HardwareVersion`, 'V1.0');
  put(`${P}DeviceInfo.UpTime`, '7200');
  put(`${P}ManagementServer.ConnectionRequestURL`, 'http://127.0.0.1:1/');
  put(`${P}ManagementServer.ConnectionRequestUsername`, 'olt-user');
  put(`${P}ManagementServer.PeriodicInformInterval`, '600');
  put(`${P}LANDevice.1.Hosts.HostNumberOfEntries`, '3');
  put(`${P}LANDevice.1.LANEthernetInterfaceNumberOfEntries`, '4');
  put(`${W}WANConnectionDevice.1.WANIPConnection.1.Name`, '1_TR069_R_VID_200');
  put(`${W}WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress`, '10.20.0.5');
  const ppp = `${W}WANConnectionDevice.2.WANPPPConnection.1.`;
  put(`${ppp}Name`, '2_INTERNET_R_VID_100');
  put(`${ppp}Enable`, 'true');
  put(`${ppp}Username`, `${vendor}user@isp`);
  put(`${ppp}Password`, opts.pppPass ?? '');
  put(`${ppp}ConnectionStatus`, 'Connected');
  put(`${ppp}ExternalIPAddress`, '100.64.1.23');
  put(`${P}LANDevice.1.WLANConfiguration.1.SSID`, `${vendor}-2G`);
  put(`${P}LANDevice.1.WLANConfiguration.1.BeaconType`, '11i');
  put(`${P}LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase`, opts.wifiPass ?? '');
  put(`${P}LANDevice.1.WLANConfiguration.1.Enable`, 'true');
  put(`${P}LANDevice.1.WLANConfiguration.1.SSIDAdvertisementEnabled`, 'true');
  if (vendor === 'zte') {
    put(`${ppp}X_ZTE-COM_VLANID`, '100');
    put(`${ppp}X_ZTE-COM_VLANEnable`, 'true');
    put(`${ppp}X_ZTE-COM_ServiceList`, 'INTERNET');
    put(`${W}X_ZTE-COM_WANPONInterfaceConfig.RXPower`, '-19.87');
    put(`${W}WANConnectionDevice.3.WANPPPConnectionNumberOfEntries`, '0'); // WCD kosong dari OLT
  } else if (vendor === 'huawei') {
    put(`${ppp}X_HW_VLAN`, '100');
    put(`${ppp}X_HW_SERVICELIST`, 'INTERNET');
    for (let i = 1; i <= 4; i++) { put(`${ppp}X_HW_LANBIND.Lan${i}Enable`, 'true'); put(`${ppp}X_HW_LANBIND.SSID${i}Enable`, i === 1 ? 'true' : 'false'); }
    put(`${W}X_GponInterafceConfig.RXPower`, '-24.61');
  } else if (vendor === 'fiberhome') {
    put(`${ppp}X_FH_VLANID`, '100');
    put(`${ppp}X_FH_ServiceList`, 'INTERNET');
    // Binding wajib FiberHome; fhUnbound = WAN lama tanpa binding (tidak ada internet).
    put(`${ppp}X_FH_LanInterface`, opts.fhUnbound ? '' : FH_BIND_ALL);
    put(`${ppp}NATEnabled`, 'true');
    put(`${ppp}ConnectionType`, 'PPPoE_Routed');
    put(`${ppp}TransportType`, 'PPPoE');
    put(`${ppp}ConnectionTrigger`, 'AlwaysOn');
    put(`${ppp}LastConnectionError`, 'ERROR_NO_ANSWER');
    put(`${W}WANConnectionDevice.2.X_FH_WANGponLinkConfig.Mode`, '2');
    put(`${W}WANConnectionDevice.2.X_FH_WANGponLinkConfig.VLANID`, '100');
    put(`${W}X_FH_GponInterfaceConfig.RXPower`, '-21.50');
    put(`${W}X_FH_GponInterfaceConfig.TXPower`, '2.30');
    if (opts.emptySlot) {
      const s3 = `${W}WANConnectionDevice.3.WANPPPConnection.1.`;
      for (const [k, v] of [['Name', '3_INTERNET_R_VID_200'], ['Enable', 'false'], ['ConnectionType', 'PPPoE_Routed'], ['TransportType', 'PPPoE'],
        ['ConnectionTrigger', 'AlwaysOn'], ['Username', ''], ['Password', ''], ['ConnectionStatus', 'Unconfigured'], ['ExternalIPAddress', '0.0.0.0'],
        ['X_FH_VLANID', '0'], ['X_FH_ServiceList', ''], ['X_FH_LanInterface', ''], ['NATEnabled', 'false']]) put(s3 + k, v);
      put(`${W}WANConnectionDevice.3.X_FH_WANGponLinkConfig.Mode`, '0');
      put(`${W}WANConnectionDevice.3.X_FH_WANGponLinkConfig.VLANID`, '0');
    }
  } else if (vendor === 'cmcc') {
    put(`${W}WANConnectionDevice.2.X_CMCC_WANGponLinkConfig.Enable`, 'true');
    put(`${W}WANConnectionDevice.2.X_CMCC_WANGponLinkConfig.Mode`, '2');
    put(`${W}WANConnectionDevice.2.X_CMCC_WANGponLinkConfig.VLANIDMark`, '100');
    put(`${ppp}X_CMCC_ServiceList`, 'INTERNET');
    put(`${W}X_CMCC_GponInterfaceConfig.RXPower`, '125');          // 0.1 µW → -19.03 dBm
    put(`${W}X_CMCC_GponInterfaceConfig.TXPower`, '19000');        // 0.1 µW → 2.79 dBm
    put(`${W}X_CMCC_GponInterfaceConfig.TransceiverTemperature`, '11520'); // 1/256 °C → 45
  }
  // CPU/RAM per gaya vendor
  if (opts.sys !== false) {
    const DI = `${P}DeviceInfo.`;
    if (vendor === 'zte') { put(`${DI}ProcessStatus.CPUUsage`, '12'); put(`${DI}MemoryStatus.Total`, '262144'); put(`${DI}MemoryStatus.Free`, '131072'); }
    if (vendor === 'huawei') { put(`${DI}X_HW_CpuUsed`, '33'); put(`${DI}X_HW_MemUsed`, '41'); }
    if (vendor === 'cmcc') {
      put(`${DI}X_CMCC_SysInfo.CPUType`, 'MIPS'); put(`${DI}X_CMCC_SysInfo.CPUUsage`, '7');
      put(`${DI}X_CMCC_SysInfo.MemoryTotal`, '134217728'); put(`${DI}X_CMCC_SysInfo.MemoryFree`, '33554432');
    }
  }
  // Counter trafik dinamis: nilai = awal + laju × waktu (wrap 32-bit).
  // ZTE mulai dekat 2^32 untuk menguji wrap; CMCC sengaja tanpa counter.
  const counters = new Map();
  const traffic = opts.traffic ?? { down: 50, up: 10 };
  // Counter diakumulasi per pembacaan, sehingga laju (mbps) boleh berubah
  // kapan saja tanpa membuat counter mundur.
  const ctr = (path, mbps, start = 0) => { counters.set(path, { mbps, acc: start, at: Date.now() }); put(path, start); };
  if (vendor === 'zte') {
    ctr(`${ppp}Stats.EthernetBytesReceived`, traffic.down, 2 ** 32 - 20e6);
    ctr(`${ppp}Stats.EthernetBytesSent`, traffic.up, 1e6);
  } else if (vendor === 'huawei' || vendor === 'fiberhome') {
    ctr(`${W}WANCommonInterfaceConfig.TotalBytesReceived`, traffic.down, 5e8);
    ctr(`${W}WANCommonInterfaceConfig.TotalBytesSent`, traffic.up, 1e8);
  }
  const counterValue = (path) => {
    const c = counters.get(path);
    const now = Date.now();
    c.acc += (c.mbps * 1e6 / 8) * ((now - c.at) / 1000);
    c.at = now;
    return String(Math.floor(c.acc) % 2 ** 32);
  };
  const rebuild = () => {
    objects.clear();
    for (const k of V.keys()) {
      const segs = k.split('.');
      for (let i = 1; i < segs.length; i++) objects.add(`${segs.slice(0, i).join('.')}.`);
    }
    for (const o of extraObjects) objects.add(o);
    for (const o of [...objects]) {
      if (/WANConnectionDevice\.\d+\.$/.test(o)) { objects.add(`${o}WANPPPConnection.`); objects.add(`${o}WANIPConnection.`); }
    }
  };
  rebuild();
  return { V, objects, extraObjects, rebuild, counters, counterValue, oui, pc, man, serial, vendor, opts, log: [], errors: [], spvLog: [], rebooted: 0 };
}

const esc = (v) => String(v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const env = (dev, body) => `<?xml version="1.0"?><soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soap-enc="http://schemas.xmlsoap.org/soap/encoding/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:cwmp="urn:dslforum-org:${dev.opts.ns ?? 'cwmp-1-0'}"><soap-env:Header><cwmp:ID soap-env:mustUnderstand="1">1</cwmp:ID></soap-env:Header><soap-env:Body>${body}</soap-env:Body></soap-env:Envelope>`;
const fault = (dev, code, msg) => env(dev, `<soap-env:Fault><faultcode>Client</faultcode><faultstring>CWMP fault</faultstring><detail><cwmp:Fault><FaultCode>${code}</FaultCode><FaultString>${msg}</FaultString></cwmp:Fault></detail></soap-env:Fault>`);
const VENDOR_PREFIX = { zte: /^X_ZTE-COM_/, huawei: /^X_HW_/, fiberhome: /^X_FH_/, cmcc: /^X_CMCC_/ };

function respond(dev, xml) {
  const m = /<cwmp:([A-Za-z]+)>/.exec(xml);
  if (!m) return null;
  const method = m[1];
  dev.log.push(method);
  if (dev.opts.strictNs && !xml.includes(`urn:dslforum-org:${dev.opts.ns}`)) {
    dev.errors.push(`namespace salah pada ${method}`);
    return null;
  }
  const allowed = (leaf) => VENDOR_PREFIX[dev.vendor].test(leaf);
  if (method === 'GetParameterValues') {
    if (/<CommandKey>/.test(xml)) return fault(dev, 9003, 'Invalid arguments');
    const out = [];
    for (const p of [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((x) => unesc(x[1]))) {
      if (p.endsWith('.')) {
        if (!dev.objects.has(p)) return fault(dev, 9005, 'Invalid parameter name');
        for (const [k, v] of dev.V) if (k.startsWith(p)) out.push([k, dev.opts.hideSecrets && /(Password|KeyPassphrase)$/.test(k) ? '' : v]);
      } else {
        if (!dev.V.has(p)) return fault(dev, 9005, 'Invalid parameter name');
        // hideSecrets: firmware yang mengembalikan string kosong saat sandi dibaca (TR-098).
        const secret = dev.opts.hideSecrets && /(Password|KeyPassphrase)$/.test(p);
        out.push([p, secret ? '' : dev.counters.has(p) ? dev.counterValue(p) : dev.V.get(p)]);
      }
    }
    return env(dev, `<cwmp:GetParameterValuesResponse><ParameterList soap-enc:arrayType="cwmp:ParameterValueStruct[${out.length}]">${out.map(([k, v]) => `<ParameterValueStruct><Name>${esc(k)}</Name><Value xsi:type="xsd:string">${esc(v)}</Value></ParameterValueStruct>`).join('')}</ParameterList></cwmp:GetParameterValuesResponse>`);
  }
  if (method === 'GetParameterNames') {
    const pp = /<ParameterPath>([^<]*)<\/ParameterPath>/.exec(xml);
    if (!pp) return fault(dev, 9003, 'Invalid arguments');
    const path = unesc(pp[1]);
    const nextLevel = /<NextLevel>(true|1)</.test(xml);
    if (!nextLevel && dev.opts.rejectDeep) return fault(dev, 9005, 'Invalid parameter name');
    if (path && !dev.objects.has(path)) return fault(dev, 9005, 'Invalid parameter name');
    const depth = path.split('.').length;
    const names = new Set();
    for (const o of dev.objects) if (o.startsWith(path) && o !== path && (!nextLevel || o.split('.').length === depth + 1)) names.add(o);
    for (const k of dev.V.keys()) if (k.startsWith(path) && (!nextLevel || k.split('.').length === depth)) names.add(k);
    return env(dev, `<cwmp:GetParameterNamesResponse><ParameterList soap-enc:arrayType="cwmp:ParameterInfoStruct[${names.size}]">${[...names].map((n) => `<ParameterInfoStruct><Name>${esc(n)}</Name><Writable>1</Writable></ParameterInfoStruct>`).join('')}</ParameterList></cwmp:GetParameterNamesResponse>`);
  }
  if (method === 'SetParameterValues') {
    const items = [...xml.matchAll(/<Name>([^<]*)<\/Name><Value[^>]*>([^<]*)<\/Value>/g)].map((x) => [unesc(x[1]), unesc(x[2])]);
    for (const [n] of items) {
      if (dev.V.has(n)) continue;
      const parent = n.slice(0, n.lastIndexOf('.') + 1);
      const leaf = n.slice(n.lastIndexOf('.') + 1);
      const parentOk = dev.objects.has(parent) || dev.objects.has(parent.replace(/[^.]+\.$/, ''));
      if (!parentOk || (/^X_/.test(leaf) && !allowed(leaf)) || (/\.X_[^.]+\.[^.]+$/.test(n) && !allowed(n.split('.').slice(-2)[0]))) {
        return fault(dev, 9005, 'Invalid parameter name');
      }
    }
    for (const [n, v] of items) dev.V.set(n, v);
    dev.spvLog.push(items.map(([n, v]) => `${n.split('.').slice(-2).join('.')}=${v}`).join(' '));
    dev.rebuild();
    return env(dev, '<cwmp:SetParameterValuesResponse><Status>0</Status></cwmp:SetParameterValuesResponse>');
  }
  if (method === 'AddObject') {
    const obj = unesc(/<ObjectName>([^<]*)<\/ObjectName>/.exec(xml)[1]);
    if (!dev.objects.has(obj)) return fault(dev, 9005, 'Invalid object');
    let n = 1;
    while (dev.objects.has(`${obj}${n}.`)) n++;
    dev.extraObjects.add(`${obj}${n}.`);
    if (/WANConnectionDevice\.$/.test(obj) && dev.vendor === 'cmcc') dev.extraObjects.add(`${obj}${n}.X_CMCC_WANGponLinkConfig.`);
    dev.rebuild();
    return env(dev, `<cwmp:AddObjectResponse><InstanceNumber>${n}</InstanceNumber><Status>0</Status></cwmp:AddObjectResponse>`);
  }
  if (method === 'DeleteObject') {
    const obj = unesc(/<ObjectName>([^<]*)<\/ObjectName>/.exec(xml)[1]);
    for (const k of [...dev.V.keys()]) if (k.startsWith(obj)) dev.V.delete(k);
    for (const o of [...dev.extraObjects]) if (o.startsWith(obj)) dev.extraObjects.delete(o);
    dev.rebuild();
    return env(dev, '<cwmp:DeleteObjectResponse><Status>0</Status></cwmp:DeleteObjectResponse>');
  }
  if (method === 'Reboot') { dev.rebooted++; return env(dev, '<cwmp:RebootResponse/>'); }
  return fault(dev, 9000, 'Method not supported');
}

function post(url, body, cookie, fresh) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      agent: fresh ? new http.Agent({ keepAlive: false }) : undefined,
      headers: { 'content-type': 'text/xml;charset=UTF-8', 'content-length': Buffer.byteLength(body), ...(cookie ? { cookie } : {}) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: d, setCookie: res.headers['set-cookie'] ?? [] }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Satu sesi CWMP; kembalikan jumlah RPC dari ACS yang dijawab. */
export async function inform(dev, url, event = '2 PERIODIC') {
  let cookie = '';
  const send = async (body) => {
    const r = await post(url, body, dev.opts.noCookie ? '' : cookie, !!dev.opts.freshConn);
    for (const c of r.setCookie) if (c.startsWith('acs_session=')) cookie = c.split(';')[0];
    return r;
  };
  const iv = ['InternetGatewayDevice.DeviceInfo.SoftwareVersion', 'InternetGatewayDevice.ManagementServer.ConnectionRequestURL'];
  const pl = iv.map((k) => `<ParameterValueStruct><Name>${k}</Name><Value xsi:type="xsd:string">${esc(dev.V.get(k))}</Value></ParameterValueStruct>`).join('');
  let r = await send(env(dev,
    `<cwmp:Inform><DeviceId><Manufacturer>${esc(dev.man)}</Manufacturer><OUI>${dev.oui}</OUI><ProductClass>${dev.pc}</ProductClass><SerialNumber>${dev.serial}</SerialNumber></DeviceId>` +
    `<Event soap-enc:arrayType="cwmp:EventStruct[1]"><EventStruct><EventCode>${event}</EventCode><CommandKey></CommandKey></EventStruct></Event>` +
    `<MaxEnvelopes>1</MaxEnvelopes><CurrentTime>2026-10-08T00:00:00Z</CurrentTime><RetryCount>0</RetryCount>` +
    `<ParameterList soap-enc:arrayType="cwmp:ParameterValueStruct[2]">${pl}</ParameterList></cwmp:Inform>`));
  r = await send('');
  for (let i = 0; i < 400; i++) {
    if (r.status === 204 || r.text === '') return i;
    if (dev.opts.strictEnd && /<soap-env:Body>\s*<\/soap-env:Body>|<soap-env:Body\/>/.test(r.text)) {
      dev.errors.push('ACS mengirim amplop kosong, bukan HTTP 204');
      return i;
    }
    const reply = respond(dev, r.text);
    if (!reply) return i;
    r = await send(reply);
  }
  return 400;
}

/** Ulang sesi sampai antrean ACS habis (batas RPC per sesi membaginya). */
export async function settle(dev, url, first = '1 BOOT', budget = 40) {
  const per = [];
  for (let i = 0; i < 8; i++) {
    const n = await inform(dev, url, i === 0 ? first : '6 CONNECTION REQUEST');
    per.push(n);
    if (n < budget) break;
  }
  return per;
}
