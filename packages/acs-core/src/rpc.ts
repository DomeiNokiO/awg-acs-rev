/**
 * Pembangun RPC keluar (ACS -> CPE) dan pemroses respons masuk.
 *
 * Setiap RPC di sini punya pasangan: build<Method>() untuk mengirim dan
 * handle<Method>Response() untuk menangani balasannya. Tidak ada RPC yang
 * dikirim tanpa pemrosesnya — kalau tidak, sesi akan menggantung.
 *
 * Penting soal bentuk XML: di TR-069, elemen seperti <Name>, <ParameterKey>,
 * <ObjectName>, <CommandKey> bertipe xsd:string dan berisi TEKS POLOS.
 * Membungkusnya dengan elemen bersarang (<cwmp:string>) membuat perangkat
 * asli membalas fault 9002/9018. Sementara <ParameterNames> di
 * GetParameterValues memang diulang sebagai banyak elemen sibling.
 */
import { escapeXml, emptyEl, valueElement, text, toArray } from './soap.ts';

export type XsdType =
  | 'xsd:string' | 'xsd:int' | 'xsd:unsignedInt' | 'xsd:boolean'
  | 'xsd:dateTime' | 'xsd:base64Binary' | 'xsd:hexBinary';

export interface ParamValue { name: string; type: XsdType; value: string }

export interface Rpc {
  /** Kunci yang dipakai mencocokkan respons CPE. */
  key: string;
  method: string;
  xml: string;
}

/* ------------------------------------------------------------------ *
 * Pembangun (outbound)
 * ------------------------------------------------------------------ */

export function buildGetParameterValues(key: string, paths: string[]): Rpc {
  // ParameterNames adalah ARRAY bertipe yang berisi elemen <string>, BUKAN
  // tag <ParameterNames> berulang. Firmware ZTE/FiberHome yang menerima
  // bentuk berulang tanpa arrayType membalas ParameterList KOSONG — bukan
  // Fault — sehingga ACS mengira "tidak ada nilai". Bentuk ini yang
  // dipakai GenieACS.
  //
  // TIDAK ada <CommandKey> di sini: GetParameterValues di TR-069 hanya
  // punya argumen ParameterNames. Elemen tambahan membuat firmware yang
  // ketat (Huawei, sebagian ZTE) membalas Fault 9003 sehingga redaman dan
  // PPPoE tak pernah terbaca. Pencocokan batch ↔ fault dilakukan sesi
  // lewat `Rpc.key` (lihat CwmpSession.lastSentKey).
  const names =
    `<ParameterNames soap-enc:arrayType="xsd:string[${paths.length}]">` +
    paths.map((p) => `<string>${escapeXml(p)}</string>`).join('') +
    `</ParameterNames>`;
  return {
    key,
    method: 'GetParameterValues',
    xml: `<cwmp:GetParameterValues>${names}</cwmp:GetParameterValues>`,
  };
}

export function buildGetParameterNames(key: string, path: string, nextLevel: boolean): Rpc {
  return {
    key,
    method: 'GetParameterNames',
    xml:
      // Argumen TR-069 bernama ParameterPath (bukan ParameterName). Nama
      // yang salah membuat perangkat menganggap path kosong = SELURUH
      // pohon (respons raksasa) atau menolak dengan Fault 9003.
      `<cwmp:GetParameterNames>` +
      `<ParameterPath>${escapeXml(path)}</ParameterPath>` +
      `<NextLevel>${nextLevel ? 'true' : 'false'}</NextLevel>` +
      `</cwmp:GetParameterNames>`,
  };
}

export function buildSetParameterValues(key: string, params: ParamValue[], parameterKey = ''): Rpc {
  const list = params
    .map(
      (p) =>
        `<ParameterValueStruct><Name>${escapeXml(p.name)}</Name>${valueElement(
          p.type,
          p.value,
        )}</ParameterValueStruct>`,
    )
    .join('');
  return {
    key,
    method: 'SetParameterValues',
    xml:
      `<cwmp:SetParameterValues>` +
      // ParameterList juga array bertipe; sama alasannya dengan
      // GetParameterValues: tanpa arrayType sebagian firmware mengabaikan
      // isinya dan tetap membalas Status 0 seolah berhasil.
      `<ParameterList soap-enc:arrayType="cwmp:ParameterValueStruct[${params.length}]">${list}</ParameterList>` +
      `<ParameterKey>${escapeXml(parameterKey)}</ParameterKey>` +
      `</cwmp:SetParameterValues>`,
  };
}

export function buildAddObject(key: string, objectName: string, parameterKey = ''): Rpc {
  return {
    key,
    method: 'AddObject',
    xml:
      `<cwmp:AddObject><ObjectName>${escapeXml(objectName)}</ObjectName>` +
      `<ParameterKey>${escapeXml(parameterKey)}</ParameterKey></cwmp:AddObject>`,
  };
}

export function buildDeleteObject(key: string, objectName: string, parameterKey = ''): Rpc {
  return {
    key,
    method: 'DeleteObject',
    xml:
      `<cwmp:DeleteObject><ObjectName>${escapeXml(objectName)}</ObjectName>` +
      `<ParameterKey>${escapeXml(parameterKey)}</ParameterKey></cwmp:DeleteObject>`,
  };
}

export function buildReboot(key: string, commandKey = ''): Rpc {
  return {
    key,
    method: 'Reboot',
    xml: `<cwmp:Reboot><CommandKey>${escapeXml(commandKey)}</CommandKey></cwmp:Reboot>`,
  };
}

export function buildFactoryReset(key: string): Rpc {
  return { key, method: 'FactoryReset', xml: emptyEl('FactoryReset') };
}

export interface DownloadSpec {
  commandKey?: string;
  /** "1 Firmware Upgrade Image", "2 Web Content", "3 Vendor Configuration File" */
  fileType: string;
  url: string;
  username?: string;
  password?: string;
  fileSize?: number;
  targetFileName?: string;
  delaySeconds?: number;
}

export function buildDownload(key: string, spec: DownloadSpec): Rpc {
  return {
    key,
    method: 'Download',
    xml:
      `<cwmp:Download>` +
      `<CommandKey>${escapeXml(spec.commandKey ?? key)}</CommandKey>` +
      `<FileType>${escapeXml(spec.fileType)}</FileType>` +
      `<URL>${escapeXml(spec.url)}</URL>` +
      `<Username>${escapeXml(spec.username ?? '')}</Username>` +
      `<Password>${escapeXml(spec.password ?? '')}</Password>` +
      `<FileSize>${escapeXml(String(spec.fileSize ?? 0))}</FileSize>` +
      `<TargetFileName>${escapeXml(spec.targetFileName ?? '')}</TargetFileName>` +
      `<DelaySeconds>${escapeXml(String(spec.delaySeconds ?? 0))}</DelaySeconds>` +
      `</cwmp:Download>`,
  };
}

/* ------------------------------------------------------------------ *
 * Respons (inbound) -> hasil terstruktur
 * ------------------------------------------------------------------ */

export interface GpvResult {
  values: Record<string, string>;
  /** Tipe xsi:type yang dilaporkan perangkat per parameter (bila ada). */
  types: Record<string, string>;
  errors: { name: string; code: number; message: string }[];
}
export interface GpnResult { nodes: { name: string; writable: boolean }[] }

const asArray = <T>(v: T | T[] | undefined | null): T[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];

export function handleGetParameterValuesResponse(body: Record<string, unknown>): GpvResult {
  const out: GpvResult = { values: {}, types: {}, errors: [] };
  for (const raw of asArray(body['ParameterList'] as unknown)) {
    const s = raw as Record<string, unknown>;
    if (!s || typeof s !== 'object') continue;
    const name = text(s['Name']);
    if (!name) continue;
    // Beberapa vendor mengembalikan struktur kesalahan per-parameter di
    // dalam ParameterList, bukan SOAP Fault terpisah.
    if (s['FaultCode'] !== undefined) {
      out.errors.push({ name, code: Number(text(s['FaultCode'])), message: text(s['FaultString']) });
      continue;
    }
    if (s['Value'] === undefined) {
      out.errors.push({ name, code: 9018, message: 'Parameter tidak ditemukan di perangkat' });
      continue;
    }
    out.values[name] = text(s['Value']);
    const v = s['Value'];
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const t = text(o['@_type'] ?? o['@_xsi:type']);
      if (t) out.types[name] = t.includes(':') ? t : `xsd:${t}`;
    }
  }
  return out;
}

export function handleGetParameterNamesResponse(body: Record<string, unknown>): GpnResult {
  const out: GpnResult = { nodes: [] };
  for (const raw of asArray(body['ParameterList'] as unknown)) {
    const s = raw as Record<string, unknown>;
    if (!s || typeof s !== 'object') continue;
    const name = text(s['Name']);
    if (!name) continue;
    const w = text(s['Writable']).toLowerCase();
    out.nodes.push({ name, writable: w === 'true' || w === '1' });
  }
  return out;
}

export function handleSetParameterValuesResponse(body: Record<string, unknown>): { status: number } {
  const status = Number(text(body['Status']));
  return { status: Number.isFinite(status) ? status : -1 };
}

export function handleAddObjectResponse(body: Record<string, unknown>): { instanceNumber: number; status: number } {
  return {
    instanceNumber: Number(text(body['InstanceNumber'])) || 0,
    status: Number(text(body['Status'])) || 0,
  };
}

export function handleTransferComplete(body: Record<string, unknown>): {
  commandKey: string; faultCode: number; faultString: string; startTime: string; completeTime: string; fileSize: number;
} {
  const f = (body['FaultStruct'] ?? {}) as Record<string, unknown>;
  return {
    commandKey: text(body['CommandKey']),
    faultCode: Number(text(f['FaultCode'])) || 0,
    faultString: text(f['FaultString']),
    startTime: text(body['StartTime']),
    completeTime: text(body['CompleteTime']),
    fileSize: Number(text(body['FileSize'])) || 0,
  };
}

/** Fault CWMP spesifik (detail/faultcode angka 9xxx). */
export function parseCwmpFault(fault: { faultcode: string; faultstring: string; detail: Record<string, unknown> }): {
  code: number; message: string; raw: string;
} {
  const d = fault.detail ?? {};
  const code = Number(text(d['FaultCode']));
  const message = text(d['FaultString']) || fault.faultstring;
  return { code: Number.isFinite(code) ? code : -1, message, raw: fault.faultcode };
}

/** Fault code CWMP yang umum — untuk pesan error yang manusiawi. */
export const CWMP_FAULTS: Record<number, string> = {
  9000: 'Method not supported',
  9001: 'Invalid parameter name',
  9002: 'Invalid parameter type',
  9003: 'Invalid parameter value',
  9004: 'Read-only parameter',
  9005: 'Parameter conflict',
  9006: 'Resource exceeded',
  9007: 'Invalid parameter value (type/range)',
  9008: 'Attempt to set a non-writable parameter',
  9009: 'Resource unavailable',
  9010: 'Timeout exceeded',
  9011: 'Unsupported protocol version',
  9012: 'Request not supported',
  9013: 'Download failed',
  9014: 'Cancellation failed',
  9015: 'Invalid argument',
  9016: 'Resources exhausted',
  9017: 'Invalid configuration file',
  9018: 'Parameter name not found',
};
