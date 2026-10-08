/**
 * Lapisan SOAP mentah untuk CWMP/TR-069.
 *
 * Tugasnya hanya dua: memecah envelope jadi { id, method, params } dan
 * merakit envelope keluar. Semua keputusan protokol ada di cwmp.ts.
 *
 * Catatan keamanan:
 *  - processEntities dibiarkan true hanya untuk entri bawaan XML;
 *    payload dibatasi ukurannya di lapisan HTTP (1 MB) supaya tidak ada
 *    ekspansi entitas (billion-laughs).
 *  - Semua nilai keluar lewat escapeXml(), tidak pernah string concat polos.
 */
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

const ESC: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
};

export function escapeXml(v: unknown): string {
  return String(v).replace(/[&<>"']/g, (c) => ESC[c]!);
}

export interface ParsedEnvelope {
  /** Nilai cwmp:ID dari header. Wajib ada pada request CPE yang valid. */
  id: string | null;
  /** Nama elemen tubuh, mis. "Inform", "GetParameterValuesResponse". */
  method: string | null;
  /** Isi tubuh, dinormalisasi (array dibuat selalu array). */
  body: Record<string, unknown> | null;
  /** Fault SOAP mentah bila envelope adalah fault. */
  fault: { faultcode: string; faultstring: string; detail: Record<string, unknown> } | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,          // cwmp:Inform -> Inform, soap-env:Envelope -> Envelope
  parseTagValue: false,          // nilai mentah string; koercing tipe dilakukan terpisah
  parseAttributeValue: false,
  trimValues: true,
  ignoreDeclaration: true,
  processEntities: true,
  allowBooleanAttributes: false,
});

/** Selalu kembalikan array, berapa pun bentuk masukannya. */
function arr<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Ambil teks dari node yang bisa berupa string atau objek dengan #text. */
export function text(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('#text' in o) return text(o['#text']);
  }
  return '';
}

/**
 * ParameterList punya tiga bentuk nyata di lapangan:
 *   1. <ParameterList><string>a</string><string>b</string></ParameterList>
 *   2. <ParameterList soap-enc:arrayType="..."><string>...</string></ParameterList>
 *   3. <ParameterList><soap-enc:Array><soap-enc:string>...</soap-enc:string></soap-enc:Array></ParameterList>
 * Ditambah setiap elemen bisa berupa objek tunggal atau array. Tiga bentuk
 * itu memang semua yang muncul di perangkat nyata (ZTE/Huawei/Fiberhome).
 */
function normalizeParameterList(raw: unknown): unknown[] {
  if (raw === undefined || raw === null) return [];
  const node = Array.isArray(raw) ? raw[0] : raw;
  if (node === null || node === undefined) return [];
  if (typeof node !== 'object') return arr(node);

  const o = node as Record<string, unknown>;
  if ('Array' in o) return arr(o['Array'] === null ? undefined : (o['Array'] as Record<string, unknown>)['string']).map(text);
  if ('string' in o) return arr(o['string']).map(text);
  // objek langsung: kemungkinan daftar ParameterValueStruct / ParameterInfoStruct
  const keys = Object.keys(o).filter((k) => !k.startsWith('@_'));
  if (keys.length === 1 && keys[0] !== undefined) return arr(o[keys[0]]);
  return arr(node);
}

function unwrapArray(node: unknown): unknown[] {
  if (node === null || node === undefined) return [];
  if (typeof node !== 'object') return arr(node);
  const o = node as Record<string, unknown>;
  if ('Array' in o) {
    const inner = o['Array'];
    if (inner === null || inner === undefined) return [];
    if (typeof inner === 'object' && 'string' in (inner as Record<string, unknown>)) {
      return arr((inner as Record<string, unknown>)['string']);
    }
    return arr(inner);
  }
  if ('string' in o) return arr(o['string']);
  return arr(node);
}

export function parseEnvelope(xml: string): ParsedEnvelope {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return { id: null, method: null, body: null, fault: null };
  }

  const env = (doc['Envelope'] ?? doc) as Record<string, unknown> | undefined;
  if (!env || typeof env !== 'object') return { id: null, method: null, body: null, fault: null };

  const header = env['Header'] as Record<string, unknown> | undefined;
  let id: string | null = null;
  if (header && typeof header === 'object') {
    const idNode = header['ID'];
    if (idNode !== undefined) {
      const t = text(idNode);
      if (t !== '') id = t;
    }
  }

  const body = env['Body'] as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return { id, method: null, body: null, fault: null };

  // Fault SOAP: <Fault><faultcode/><faultstring/><detail><cwmp:Fault>...
  if ('Fault' in body) {
    const f = body['Fault'] as Record<string, unknown>;
    const detail = (f['detail'] ?? {}) as Record<string, unknown>;
    const cwmpFault = (detail['Fault'] ?? {}) as Record<string, unknown>;
    return {
      id,
      method: 'Fault',
      body: null,
      fault: {
        faultcode: text(f['faultcode']) || 'Client',
        faultstring: text(f['faultstring']) || 'Fault',
        detail: cwmpFault,
      },
    };
  }

  const keys = Object.keys(body).filter((k) => !k.startsWith('@_'));
  const method = keys[0] ?? null;
  const raw = method ? body[method] : null;

  let params: Record<string, unknown> | null = null;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    params = { ...(raw as Record<string, unknown>) };
    if ('ParameterList' in params) params['ParameterList'] = normalizeParameterList(params['ParameterList']);
    if ('ParameterNames' in params) params['ParameterNames'] = unwrapArray(params['ParameterNames']);
    if ('Event' in params) params['Event'] = unwrapArray(params['Event']);
    if ('ParameterList' in params && method === 'GetParameterNamesResponse') {
      params['ParameterList'] = arr((raw as Record<string, unknown>)['ParameterList']).flatMap((p) => {
        const pl = p as Record<string, unknown>;
        return arr(pl['ParameterInfoStruct']);
      });
    }
  } else if (raw === null || raw === '') {
    params = {}; // body kosong = CPE menunggu RPC berikutnya
  } else {
    params = {};
  }

  return { id, method, body: params, fault: null };
}

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false, // kita escape manual lewat escapeXml()
  suppressEmptyNode: true,
});

export const CWMP_NS_DEFAULT = 'urn:dslforum-org:cwmp-1-0';

const envelopeAttrs = (cwmpNs: string): string =>
  'xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/" ' +
  'xmlns:soap-enc="http://schemas.xmlsoap.org/soap/encoding/" ' +
  'xmlns:xsd="http://www.w3.org/2001/XMLSchema" ' +
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
  `xmlns:cwmp="${cwmpNs}"`;

export const ENVELOPE_ATTRS = envelopeAttrs(CWMP_NS_DEFAULT);

/** Namespace CWMP yang dipakai CPE di envelope-nya (cwmp-1-0 … cwmp-1-4). */
export function detectCwmpNs(xml: string): string | null {
  const m = /urn:dslforum-org:cwmp-1-\d/.exec(xml);
  return m ? m[0] : null;
}

/**
 * Rakit envelope lengkap dengan header cwmp:ID. `cwmpNs` mengikuti versi
 * yang dipakai CPE di Inform-nya — sebagian firmware (FiberHome, CMCC)
 * menolak RPC berbalut namespace versi lain.
 */
export function buildEnvelope(id: string, bodyXml: string, cwmpNs: string = CWMP_NS_DEFAULT): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<soap-env:Envelope ${envelopeAttrs(cwmpNs)}>` +
    `<soap-env:Header><cwmp:ID soap-env:mustUnderstand="1">${escapeXml(id)}</cwmp:ID></soap-env:Header>` +
    `<soap-env:Body>${bodyXml}</soap-env:Body>` +
    '</soap-env:Envelope>'
  );
}

/** Envelope kosong — dipakai ACS kalau tidak ada RPC untuk dikirim. */
export function emptyEnvelope(id: string): string {
  return buildEnvelope(id, '');
}

/** Isi satu elemen berisi teks, aman dari injeksi XML. */
export function el(name: string, value: unknown): string {
  return `<cwmp:${name}>${escapeXml(value)}</cwmp:${name}>`;
}

/** Elemen kosong self-closing (Reboot, FactoryResetResponse, ...). */
export function emptyEl(name: string): string {
  return `<cwmp:${name}/>`;
}

/**
 * Rakit <Value xsi:type="..."> untuk SetParameterValues.
 * Tipe harus dari daftar XSD TR-069 — nilai bebas tidak boleh lolos sebagai
 * xsd:int karena bisa bikin fault 9007 di sisi CPE.
 */
const XSD_TYPES = new Set([
  'xsd:string', 'xsd:int', 'xsd:unsignedInt', 'xsd:boolean',
  'xsd:dateTime', 'xsd:base64Binary', 'xsd:hexBinary',
]);

export function valueElement(type: string, value: unknown): string {
  const t = XSD_TYPES.has(type) ? type : 'xsd:string';
  let v: string;
  if (t === 'xsd:boolean') {
    v = value === true || value === 'true' || value === 1 || value === '1' ? 'true' : 'false';
  } else if (t === 'xsd:int' || t === 'xsd:unsignedInt') {
    const n = Number.parseInt(String(value), 10);
    v = Number.isFinite(n) ? String(n) : '0';
  } else {
    v = String(value ?? '');
  }
  return `<Value xsi:type="${t}">${escapeXml(v)}</Value>`;
}

export { builder as xmlBuilder, arr as toArray, normalizeParameterList };
