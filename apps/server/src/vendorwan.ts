/**
 * Pengetahuan vendor untuk membuat / mengisi koneksi WAN (TR-098).
 *
 * Satu WAN internet di ONU FTTH = WANConnectionDevice (WCD) + satu
 * WANPPPConnection (PPPoE) atau WANIPConnection (IPoE/DHCP/static).
 * Bagian standar (Username, Password, ConnectionType, NAT…) sama untuk
 * semua merek; yang berbeda adalah VLAN, ServiceList, dan binding port:
 *
 * | Keluarga  | VLAN level koneksi                         | VLAN level link (WCD)                          | ServiceList          | Binding port            |
 * |-----------|--------------------------------------------|------------------------------------------------|----------------------|-------------------------|
 * | Huawei    | X_HW_VLAN (+X_HW_PRI)                      | –                                              | X_HW_SERVICELIST     | X_HW_LANBIND.LanN/SSIDN |
 * | ZTE       | X_ZTE-COM_VLANEnable + X_ZTE-COM_VLANID    | X_ZTE-COM_WANPONLinkConfig.VLANID              | X_ZTE-COM_ServiceList| X_ZTE-COM_LanInterface  |
 * | FiberHome | X_FH_VLANID / VLANID                       | X_FH_WANGponLinkConfig.Mode=2 + VLANID         | X_FH_ServiceList     | X_FH_LanInterface (WAJIB) |
 * | CMCC      | X_CMCC_VLANMode=2 + X_CMCC_VLANIDMark      | X_CMCC_WANGponLinkConfig.Enable/Mode/VLANIDMark| X_CMCC_ServiceList   | X_CMCC_LanInterface     |
 * | CT-COM    | X_CT-COM_VLANMode=2 + X_CT-COM_VLANIDMark  | X_CT-COM_WANGponLinkConfig.Enable/Mode/VLANIDMark | X_CT-COM_ServiceList | X_CT-COM_LanInterface |
 * | CU        | –                                          | X_CU_WANGponLinkConfig.Enable/Mode/VLANIDMark  | X_CU_ServiceList     | X_CU_LanInterface       |
 *
 * Sumber: forum GenieACS 7384 (FiberHome HG6143D), 7385 (CMDC/CMCC,
 * pengisian berurutan), 7365 & 5925 (Huawei HG8546M/EG8145V5, ZTE F670L),
 * genieacs-panel deviceService.js, halny HL-4GMV (X_CT-COM_WANGponLinkConfig).
 *
 * ATURAN PEMILIHAN: nama yang TERBUKTI ada di perangkat (hasil baca /
 * discovery, instans mana pun) selalu menang. Tebakan per keluarga hanya
 * dipakai bila belum ada bukti, dan dilaporkan sebagai `guessed`.
 */

export type XsdType =
  | 'xsd:string' | 'xsd:int' | 'xsd:unsignedInt' | 'xsd:boolean'
  | 'xsd:dateTime' | 'xsd:base64Binary' | 'xsd:hexBinary';

export interface Fill { name: string; type: XsdType; value: string }

export type Family = 'huawei' | 'zte' | 'fiberhome' | 'cmcc' | 'ct' | 'cu' | 'nokia';

/** Awalan ekstensi per keluarga (di area konfigurasi WAN). */
const FAMILY_PREFIX: [Family, RegExp][] = [
  ['huawei', /\.X_HW_/], ['zte', /\.X_ZTE-COM_/], ['fiberhome', /\.X_FH_/],
  ['cmcc', /\.X_CMCC_/], ['cu', /\.X_CU_/], ['ct', /\.X_CT-COM_/],
];

/**
 * Keluarga vendor untuk konfigurasi WAN — ditentukan dari ekstensi yang
 * BENAR-BENAR dipakai ONU di area WAN (WANConnectionDevice: VLAN,
 * ServiceList, binding, link config), bukan dari nama pabrikan. Hardware
 * yang sama bisa membawa firmware berbeda:
 *  - ZTE F660 ORI → `X_ZTE-COM_*` → 'zte';
 *  - ZTE F660 firmware suntikan China Mobile (V9.0.0P1T7, lapangan) →
 *    pabrikan tetap "ZTE" tetapi `X_CMCC_*` → 'cmcc'.
 * Firmware campuran: keluarga dengan bukti terbanyak; seri → keluarga
 * pabrikan bila termasuk, selain itu urutan FAMILY_PREFIX. Tanpa bukti sama
 * sekali (ONU baru, belum dipetakan) → nama pabrikan / OUI.
 */
export function detectFamily(known: Iterable<string>, manufacturer: string, oui: string): Family {
  const score = new Map<Family, number>();
  for (const p of known) {
    if (!/\.WANConnectionDevice\.\d+\./.test(p)) continue;
    for (const [f, re] of FAMILY_PREFIX) if (re.test(p)) score.set(f, (score.get(f) ?? 0) + 1);
  }
  const byName = familyByName(manufacturer, oui);
  const best = Math.max(0, ...score.values());
  if (best > 0) {
    const tied = FAMILY_PREFIX.map(([f]) => f).filter((f) => score.get(f) === best);
    return tied.includes(byName) ? byName : tied[0]!;
  }
  return byName;
}

/** Keluarga dari nama pabrikan / OUI (dipakai bila belum ada bukti path). */
function familyByName(manufacturer: string, oui: string): Family {
  const m = manufacturer.toLowerCase();
  if (/huawei/.test(m) || ['00E0FC', '4C1FCC', '00259E', '001882', 'E0247F'].includes(oui)) return 'huawei';
  if (/zte/.test(m) || ['001141', '00D0D0', 'D0608C', '344B50'].includes(oui)) return 'zte';
  if (/fiberhome|fiber home/.test(m) || ['0019E0', '241815'].includes(oui)) return 'fiberhome';
  // Firmware China Mobile (GM220-S dll.) melaporkan operator sebagai pabrikan.
  if (/cmcc|china ?mobile|chinamobile/.test(m)) return 'cmcc';
  if (/unicom|cucc/.test(m)) return 'cu';
  if (/nokia|alcatel|alcl/.test(m)) return 'nokia';
  // ODM China tanpa nama operator (CDATA, VSOL, Hioso…) umumnya memakai
  // profil gateway China Telecom.
  return 'ct';
}

/** Akses bukti perangkat (diisi configure.ts dari params ∪ discovered). */
export interface Evidence {
  exists(path: string): boolean;
  typeFor(path: string, fallback: XsdType): XsdType;
  family: Family;
}

/* ------------------------------------------------------------------ *
 * VLAN
 * ------------------------------------------------------------------ */

interface VlanScheme {
  id: string;
  level: 'conn' | 'link';
  /** Nama (relatif) yang membuktikan skema ini dipakai perangkat. */
  probe: string;
  /** Pendamping wajib/opsional: ditulis bila ada bukti atau saat menebak. */
  companions: { name: string; type: XsdType; value: string }[];
}

const U: XsdType = 'xsd:unsignedInt';
const B: XsdType = 'xsd:boolean';

const VLAN_SCHEMES: VlanScheme[] = [
  { id: 'huawei', level: 'conn', probe: 'X_HW_VLAN', companions: [] },
  { id: 'zte', level: 'conn', probe: 'X_ZTE-COM_VLANID', companions: [{ name: 'X_ZTE-COM_VLANEnable', type: B, value: 'true' }] },
  { id: 'fh-conn', level: 'conn', probe: 'X_FH_VLANID', companions: [] },
  { id: 'cmcc-conn', level: 'conn', probe: 'X_CMCC_VLANIDMark', companions: [{ name: 'X_CMCC_VLANMode', type: U, value: '2' }] },
  { id: 'ct-conn', level: 'conn', probe: 'X_CT-COM_VLANIDMark', companions: [{ name: 'X_CT-COM_VLANMode', type: U, value: '2' }] },
  { id: 'std-conn', level: 'conn', probe: 'VLANID', companions: [] },
  {
    id: 'fh-link', level: 'link', probe: 'X_FH_WANGponLinkConfig.VLANID',
    companions: [{ name: 'X_FH_WANGponLinkConfig.Mode', type: U, value: '2' }],
  },
  ...(['X_CT-COM', 'X_CMCC', 'X_CU'] as const).flatMap((v) => (['WANGponLinkConfig', 'WANEponLinkConfig'] as const).map((o) => ({
    id: `${v}-${o}`, level: 'link' as const, probe: `${v}_${o}.VLANIDMark`,
    companions: [
      { name: `${v}_${o}.Enable`, type: B, value: 'true' },
      { name: `${v}_${o}.Mode`, type: U, value: '2' },
    ],
  }))),
  { id: 'zte-link', level: 'link', probe: 'X_ZTE-COM_WANPONLinkConfig.VLANID', companions: [] },
];

/** Skema VLAN tebakan per keluarga (dipakai bila belum ada bukti). */
const FAMILY_VLAN: Record<Family, string[]> = {
  huawei: ['huawei'],
  zte: ['zte'],
  fiberhome: ['fh-link', 'fh-conn'],
  cmcc: ['cmcc-conn'],
  ct: ['X_CT-COM-WANGponLinkConfig'],
  cu: ['X_CU-WANGponLinkConfig'],
  nokia: [],
};

export interface VlanPlan { conn: Fill[]; link: Fill[]; guessed: string[]; note?: string }

/**
 * Tulisan VLAN untuk koneksi `connBase` di WCD `linkBase` (keduanya path
 * berakhiran titik; boleh instans contoh — bukti dicocokkan per bentuk).
 */
export function planVlan(e: Evidence, connBase: string, linkBase: string, vlan: number): VlanPlan {
  const out: VlanPlan = { conn: [], link: [], guessed: [] };
  const base = (s: VlanScheme) => (s.level === 'conn' ? connBase : linkBase);
  let schemes = VLAN_SCHEMES.filter((s) => e.exists(base(s) + s.probe));
  let guessing = false;
  if (!schemes.length) {
    schemes = FAMILY_VLAN[e.family].map((id) => VLAN_SCHEMES.find((s) => s.id === id)!).filter(Boolean);
    guessing = true;
  }
  if (!schemes.length) {
    out.note = 'Nama parameter VLAN perangkat ini belum diketahui — isi lewat "Parameter tambahan" atau set VLAN di OLT';
    return out;
  }
  for (const s of schemes) {
    const target = s.level === 'conn' ? out.conn : out.link;
    for (const c of s.companions) {
      if (guessing || e.exists(base(s) + c.name)) target.push({ ...c, type: e.typeFor(base(s) + c.name, c.type) });
    }
    target.push({ name: s.probe, type: e.typeFor(base(s) + s.probe, U), value: String(vlan) });
    if (guessing) out.guessed.push(s.probe);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * ServiceList & binding port
 * ------------------------------------------------------------------ */

const SERVICE_NAMES: Record<Family, string | null> = {
  huawei: 'X_HW_SERVICELIST', zte: 'X_ZTE-COM_ServiceList', fiberhome: 'X_FH_ServiceList',
  cmcc: 'X_CMCC_ServiceList', ct: 'X_CT-COM_ServiceList', cu: 'X_CU_ServiceList', nokia: null,
};

export function planService(e: Evidence, connBase: string, service: string): { fill: Fill | null; guessed: boolean } {
  const all = [...new Set([...Object.values(SERVICE_NAMES).filter((x): x is string => !!x), 'ServiceList'])];
  const found = all.find((n) => e.exists(connBase + n));
  if (found) return { fill: { name: found, type: 'xsd:string', value: service }, guessed: false };
  const g = SERVICE_NAMES[e.family];
  return g ? { fill: { name: g, type: 'xsd:string', value: service }, guessed: true } : { fill: null, guessed: false };
}

const LAN_IF: Record<Family, string | null> = {
  huawei: null, zte: 'X_ZTE-COM_LanInterface', fiberhome: 'X_FH_LanInterface',
  cmcc: 'X_CMCC_LanInterface', ct: 'X_CT-COM_LanInterface', cu: 'X_CU_LanInterface', nokia: null,
};

/**
 * Keluarga yang WAN internet-nya TIDAK meneruskan trafik tanpa binding.
 * FiberHome: `X_FH_LanInterface` kosong → klien LAN/WiFi tidak dapat
 * internet walau PPPoE Connected (lapangan, sama seperti praktik GenieACS).
 * ZTE/Huawei meneruskan tanpa binding, jadi binding di sana opsional.
 */
export function bindingRequired(family: Family): boolean {
  return family === 'fiberhome';
}

/**
 * Default NAT per layanan: WAN internet (INTERNET) perlu NAT; WAN layanan
 * manajemen/suara (TR069, VOIP) tidak — mengikuti praktik GenieACS/OLT.
 */
export function natDefault(service: string): boolean {
  const s = service.toUpperCase();
  return s.includes('INTERNET') || !/TR069|VOIP|IPTV|OTHER/.test(s);
}

/**
 * Binding port LAN/SSID ke WAN (internet hanya keluar lewat port terpilih).
 * Huawei: boolean per port; operator China/ZTE: daftar objek LAN/WLAN
 * dipisah koma.
 */
export function planBinding(
  e: Evidence, connBase: string, lan: number[], ssid: number[],
): { fills: Fill[]; guessed: boolean; note?: string } {
  if (!lan.length && !ssid.length) return { fills: [], guessed: false };
  const hw = e.exists(`${connBase}X_HW_LANBIND.Lan1Enable`);
  if (hw || e.family === 'huawei') {
    const fills: Fill[] = [];
    for (let i = 1; i <= 4; i++) {
      const n = `X_HW_LANBIND.Lan${i}Enable`;
      if (!hw || e.exists(connBase + n)) fills.push({ name: n, type: B, value: String(lan.includes(i)) });
    }
    for (let i = 1; i <= 4; i++) {
      const n = `X_HW_LANBIND.SSID${i}Enable`;
      if (!hw || e.exists(connBase + n)) fills.push({ name: n, type: B, value: String(ssid.includes(i)) });
    }
    return { fills, guessed: !hw };
  }
  const evidenced = Object.values(LAN_IF).filter((x): x is string => !!x).find((n) => e.exists(connBase + n));
  const name = evidenced ?? LAN_IF[e.family];
  if (!name) return { fills: [], guessed: false, note: 'Binding port belum didukung untuk vendor ini' };
  const objs = [
    ...lan.map((i) => `InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.${i}`),
    ...ssid.map((i) => `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}`),
  ];
  return { fills: [{ name, type: 'xsd:string', value: objs.join(',') }], guessed: !evidenced };
}

/* ------------------------------------------------------------------ *
 * Remote management (akses manajemen ONU dari sisi WAN)
 * ------------------------------------------------------------------ */

/**
 * Protokol akses manajemen yang bisa dibuka ke WAN. HTTP/HTTPS = web GUI
 * ONU; Telnet/SSH = shell; Ping = ICMP ke IP WAN ONU.
 */
export interface RemoteProtocols {
  http: boolean; https: boolean; telnet: boolean; ssh: boolean; ping: boolean;
}

export interface RemoteAccessOptions {
  enable: boolean;
  protocols: RemoteProtocols;
  /** Port web GUI di WAN (standar RemoteAccess.Port / Huawei HTTPWanPort). */
  port?: number;
}

/** Satu parameter remote access; `proven` = path terbukti ada di perangkat. */
export interface RemoteFill extends Fill { proven: boolean }

/**
 * Objek yang perlu dibuat dulu sebelum diisi (ZTE: instance ServiceControl
 * belum ada). `fills` diisi ke instans baru lebih dulu, `finalFills` (Enable)
 * terakhir — sama seperti alur AddObject WAN.
 */
export interface RemoteAddObject { objectName: string; fills: Fill[]; finalFills: Fill[]; label: string }

export interface RemotePlan { fills: RemoteFill[]; guessed: string[]; note?: string; addObject?: RemoteAddObject }

/**
 * Rencana membuka/menutup remote management (akses WAN ke ONU) untuk SEMUA
 * vendor, berbasis parameter yang TERBUKTI dipakai di lapangan (bukan standar
 * `UserInterface.RemoteAccess` yang kebanyakan ONU GPON tolak dengan Fault
 * 9003). Sumber: provision GenieACS komunitas ISP (safrinnetwork, beryindo,
 * alijayanet) yang menyepakati set yang sama.
 *
 * | Keluarga  | Parameter unlock (nilai saat AKTIF)                               |
 * |-----------|------------------------------------------------------------------|
 * | Huawei    | X_HW_Security.AclServices.{HTTP,HTTPS,TELNET,SSH}WanEnable=true,  |
 * |           | X_HW_Security.X_HW_FirewallLevel="Custom", Dosfilter ping        |
 * | FiberHome | X_FH_FireWall.REMOTEACCEnable=true, X_FH_Remoteweblogin.         |
 * |           | webloginenable="1", X_FH_ACL.Enable=1                            |
 * | ZTE       | Firewall.X_ZTE-COM_ServiceControl.IPV4ServiceControl.1.          |
 * |           | {Enable=true, Ingress="WAN_ALL", ServiceType="HTTP"}            |
 *
 * `root` = `InternetGatewayDevice.` atau `Device.`. Path TERBUKTI diantre
 * sekaligus; path tebakan (`guessed`) diantre satu per SPV di configure.ts,
 * sehingga nama yang salah (9005) tidak menggagalkan yang lain.
 */
export function planRemoteAccess(e: Evidence, root: string, o: RemoteAccessOptions): RemotePlan {
  const out: RemotePlan = { fills: [], guessed: [] };
  // `proven` = terbukti ada di unit ini → boleh dikirim satu batch; bila belum,
  // path tetap dikirim (satu per SPV di configure.ts) tetapi TIDAK dilaporkan
  // sebagai tebakan selama ia path standar-lapangan untuk keluarga vendor yang
  // sudah terdeteksi — hanya dicatat sekali lewat `out.note` bila semua belum
  // terbukti. `speculative` khusus untuk nilai yang benar-benar tebakan.
  const add = (name: string, type: XsdType, value: string, proven: boolean, speculative = false): void => {
    if (out.fills.some((f) => f.name === name)) return;
    out.fills.push({ name, type, value, proven });
    if (!proven && speculative) out.guessed.push(name);
  };
  const b = (v: boolean) => (v ? 'true' : 'false');
  const on = o.enable;

  // --- Standar TR-069: HANYA bila terbukti ada (ONU GPON umumnya 9003) ---
  const ra = `${root}UserInterface.RemoteAccess.`;
  if (e.exists(`${ra}Enable`)) {
    add(`${ra}Enable`, e.typeFor(`${ra}Enable`, 'xsd:boolean'), b(on), true);
    if (on && o.port && e.exists(`${ra}Port`)) add(`${ra}Port`, e.typeFor(`${ra}Port`, 'xsd:unsignedInt'), String(o.port), true);
    if (on && e.exists(`${ra}Protocol`)) add(`${ra}Protocol`, 'xsd:string', o.protocols.https && !o.protocols.http ? 'HTTPS' : 'HTTP', true);
  }

  // Parameter vendor hanya ada di pohon TR-098.
  if (root !== 'InternetGatewayDevice.') {
    if (!out.fills.length) out.note = 'Remote management TR-181 belum didukung — isi lewat "Parameter tambahan".';
    return out;
  }
  const P = root;

  // Probe per keluarga (terbukti ada di unit ini → batch; override famili).
  const acl = `${P}X_HW_Security.AclServices.`;
  const hwProbe = e.exists(`${acl}HTTPWanEnable`) || e.exists(`${acl}TELNETWanEnable`);
  const fhProbe = e.exists(`${P}X_FH_FireWall.REMOTEACCEnable`);
  const zteProbe = e.exists(`${P}Firewall.X_ZTE-COM_ServiceControl.IPV4ServiceControl.1.Enable`);

  // Keluarga mana yang dicoba. Keluarga pasti → skemanya sendiri; CMCC =
  // firmware China di hardware ZTE → skema ZTE; selain itu (CT-COM/CU/Nokia/
  // belum terdeteksi) → coba semua (aman: tiap path satu per SPV). Bukti path
  // selalu menambah skema terkait, apa pun nama pabrikannya.
  const attempt = new Set<Family>();
  if (e.family === 'huawei' || e.family === 'fiberhome' || e.family === 'zte') attempt.add(e.family);
  else if (e.family === 'cmcc') attempt.add('zte');
  else { attempt.add('huawei'); attempt.add('fiberhome'); attempt.add('zte'); }
  if (hwProbe) attempt.add('huawei');
  if (fhProbe) attempt.add('fiberhome');
  if (zteProbe) attempt.add('zte');

  // --- Huawei: ACL per protokol + FirewallLevel wajib "Custom" ---
  if (attempt.has('huawei')) {
    const map: [string, boolean][] = [
      ['HTTPWanEnable', o.protocols.http], ['HTTPSWanEnable', o.protocols.https],
      ['TELNETWanEnable', o.protocols.telnet], ['SSHWanEnable', o.protocols.ssh],
    ];
    for (const [leaf, want] of map) add(`${acl}${leaf}`, 'xsd:boolean', b(on && want), hwProbe);
    // Tanpa FirewallLevel=Custom, akses WAN tetap diblokir firewall Huawei.
    if (on) add(`${P}X_HW_Security.X_HW_FirewallLevel`, 'xsd:string', 'Custom', hwProbe);
    // Ping ke IP WAN: IcmpEchoReplyEn (1 = balas). Hanya saat diminta.
    if (o.protocols.ping) add(`${P}X_HW_Security.Dosfilter.IcmpEchoReplyEn`, 'xsd:string', on ? '1' : '0', e.exists(`${P}X_HW_Security.Dosfilter.IcmpEchoReplyEn`));
  }

  // --- FiberHome: firewall remote + web login + ACL ---
  if (attempt.has('fiberhome')) {
    add(`${P}X_FH_FireWall.REMOTEACCEnable`, 'xsd:boolean', b(on), fhProbe);
    // Web GUI (HTTP) khusus FiberHome; nilai string "1"/"0".
    add(`${P}X_FH_Remoteweblogin.webloginenable`, 'xsd:string', on && (o.protocols.http || o.protocols.https) ? '1' : '0', e.exists(`${P}X_FH_Remoteweblogin.webloginenable`));
    if (on) add(`${P}X_FH_ACL.Enable`, e.typeFor(`${P}X_FH_ACL.Enable`, 'xsd:unsignedInt'), '1', e.exists(`${P}X_FH_ACL.Enable`));
  }

  // --- ZTE: ServiceControl instance 1. Bila instance belum ada, DIBUAT dulu
  //     (AddObject) lalu diisi, supaya sekali klik langsung membuka web. ---
  if (attempt.has('zte')) {
    const z1 = `${P}Firewall.X_ZTE-COM_ServiceControl.IPV4ServiceControl.1.`;
    const stype = o.protocols.https && !o.protocols.http ? 'HTTPS' : 'HTTP';
    if (zteProbe) {
      add(`${z1}Enable`, 'xsd:boolean', b(on), true);
      if (on) { add(`${z1}Ingress`, 'xsd:string', 'WAN_ALL', true); add(`${z1}ServiceType`, 'xsd:string', stype, true); }
    } else if (on && (e.family === 'zte' || e.family === 'cmcc')) {
      // Keluarga ZTE tanpa instance → buat instance ServiceControl lalu isi.
      out.addObject = {
        objectName: `${P}Firewall.X_ZTE-COM_ServiceControl.IPV4ServiceControl.`,
        fills: [
          { name: 'ServiceType', type: 'xsd:string', value: stype },
          { name: 'Ingress', type: 'xsd:string', value: 'WAN_ALL' },
        ],
        finalFills: [{ name: 'Enable', type: 'xsd:boolean', value: 'true' }],
        label: 'Remote management ZTE: buat ServiceControl',
      };
    } else if (on) {
      // Shotgun (keluarga tak dikenal): coba langsung instance 1, satu per SPV.
      add(`${z1}Enable`, 'xsd:boolean', b(on), false);
      add(`${z1}Ingress`, 'xsd:string', 'WAN_ALL', false);
      add(`${z1}ServiceType`, 'xsd:string', stype, false);
    }
  }

  if (!out.fills.length && !out.addObject) {
    out.note = 'Parameter remote management perangkat ini belum diketahui — isi lewat "Parameter tambahan" atau set di OLT.';
  } else if (!out.fills.some((f) => f.proven) && out.fills.length) {
    out.note = 'Parameter remote dikirim satu per satu (belum terkonfirmasi di unit ini) — path standar-lapangan per keluarga vendor. Pantau hasil tiap parameter di tab Peristiwa/Antrean Tugas.';
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Parameter standar koneksi
 * ------------------------------------------------------------------ */

export interface StdOptions {
  kind: 'ppp' | 'ip';
  name?: string;
  /** null = jangan ubah ConnectionType (isi slot yang sudah benar). */
  connectionType: string | null;
  bridge: boolean;
  /** NATEnabled untuk mode route (default true). TR069/VOIP umumnya tanpa NAT. */
  nat?: boolean;
  username?: string;
  password?: string;
  staticIp?: string;
  netmask?: string;
  gateway?: string;
  dns?: string;
}

/**
 * Parameter standar TR-098. Parameter opsional (TransportType,
 * ConnectionTrigger, PPPAuthenticationProtocol) hanya ditulis bila terbukti
 * ada — sebagian firmware menolak nama yang tidak dikenalnya (SPV atomik).
 */
export function planStandard(e: Evidence, connBase: string, o: StdOptions): Fill[] {
  const f: Fill[] = [];
  const S: XsdType = 'xsd:string';
  if (o.name) f.push({ name: 'Name', type: S, value: o.name });
  if (o.connectionType) f.push({ name: 'ConnectionType', type: S, value: o.connectionType });
  if (o.kind === 'ppp') {
    if (e.exists(`${connBase}TransportType`)) f.push({ name: 'TransportType', type: S, value: 'PPPoE' });
    if (o.username !== undefined && o.username !== '') f.push({ name: 'Username', type: S, value: o.username });
    if (o.password !== undefined && o.password !== '') f.push({ name: 'Password', type: S, value: o.password });
    if (!o.bridge) {
      if (e.exists(`${connBase}PPPAuthenticationProtocol`)) f.push({ name: 'PPPAuthenticationProtocol', type: S, value: 'AUTO' });
      if (e.exists(`${connBase}ConnectionTrigger`)) f.push({ name: 'ConnectionTrigger', type: S, value: 'AlwaysOn' });
      f.push({ name: 'NATEnabled', type: B, value: String(o.nat !== false) });
    }
  } else if (!o.bridge) {
    f.push({ name: 'AddressingType', type: S, value: o.staticIp ? 'Static' : 'DHCP' });
    f.push({ name: 'NATEnabled', type: B, value: String(o.nat !== false) });
    if (o.staticIp) {
      f.push({ name: 'ExternalIPAddress', type: S, value: o.staticIp });
      f.push({ name: 'SubnetMask', type: S, value: o.netmask || '255.255.255.0' });
      if (o.gateway) f.push({ name: 'DefaultGateway', type: S, value: o.gateway });
      if (o.dns) f.push({ name: 'DNSServers', type: S, value: o.dns });
    }
  }
  return f.map((x) => ({ ...x, type: e.typeFor(connBase + x.name, x.type) }));
}

/**
 * ConnectionType untuk WAN baru. Urutan: pilihan operator → nilai yang
 * sudah dipakai koneksi lain di perangkat ini (mis. "PPPoE_Routed" di
 * sebagian FiberHome) → standar TR-098.
 */
export function chooseConnectionType(
  kind: 'ppp' | 'ip', bridge: boolean, observed: string[], requested?: string,
): string {
  if (requested && /^[A-Za-z][A-Za-z0-9_]{2,31}$/.test(requested)) return requested;
  const want = bridge ? /Bridged/i : /Routed/i;
  const seen = observed.find((t) => want.test(t));
  if (seen) return seen;
  if (kind === 'ppp') return bridge ? 'PPPoE_Bridged' : 'IP_Routed';
  return bridge ? 'IP_Bridged' : 'IP_Routed';
}

/** Pilihan ConnectionType untuk UI: yang dipakai perangkat + standar. */
export function connectionTypeOptions(kind: 'ppp' | 'ip', observed: string[]): string[] {
  const std = kind === 'ppp' ? ['IP_Routed', 'PPPoE_Bridged'] : ['IP_Routed', 'IP_Bridged'];
  return [...new Set([...observed, ...std])];
}
