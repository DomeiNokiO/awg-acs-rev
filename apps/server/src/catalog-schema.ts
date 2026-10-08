/**
 * Validator skema untuk katalog parameter.
 *
 * Dipakai di dua tempat:
 *  1. Loader   — memutuskan entri mana yang boleh dipakai saat membaca file.
 *  2. Endpoint impor — menolak file yang rusak sebelum menimpa katalog aktif.
 *
 * Pembagian tingkat sengaja dibedakan:
 *
 *   FATAL   = struktur file tidak bisa dipakai sama sekali (bukan objek,
 *             standard bukan objek, models bukan array). Impor DITOLAK.
 *   WARNING = entri individual yang tidak valid. Entri itu dibuang, sisanya
 *             tetap dipakai, dan alasannya dilaporkan.
 *
 * Alasannya: operator lebih baik mendapat 238 path valid plus daftar 2 path
 * yang dibuang, ketimbang ditolak total karena dua ketikan salah di satu
 * entri. Sebaliknya file yang strukturnya hancur tidak boleh menimpa data
 * yang sedang berjalan.
 */

/** Tipe yang diizinkan spesifikasi TR-069 untuk nilai parameter. */
export const PARAM_TYPES = [
  'xsd:string', 'xsd:int', 'xsd:unsignedInt', 'xsd:boolean',
  'xsd:dateTime', 'xsd:base64Binary', 'xsd:hexBinary',
] as const;

export const PARAM_ACCESS = ['read', 'readWrite'] as const;

/** Prefix root yang sah per data model. */
const TR098_PREFIX = 'InternetGatewayDevice.';
const TR181_PREFIX = 'Device.';

export interface ValidationReport {
  /** false = file tidak bisa dipakai, jangan ditulis. */
  ok: boolean;
  fatal: string[];
  warnings: string[];
  counts: { tr098: number; tr181: number; models: number; params: number };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validasi satu entri parameter. Mengembalikan pesan kesalahan, atau null
 * kalau entri layak pakai.
 */
function checkParam(p: unknown, where: string, prefix: string | null): string | null {
  if (!isObject(p)) return `${where}: entri bukan objek`;
  const path = p['path'];
  if (typeof path !== 'string' || path.trim() === '') return `${where}: path kosong atau bukan string`;
  if (prefix && !path.startsWith(prefix)) {
    return `${where}: path "${path}" tidak diawali ${prefix}`;
  }

  const label = p['label'];
  if (typeof label !== 'string' || label.trim() === '') return `${where}: label kosong ("${path}")`;

  const type = p['type'];
  if (typeof type !== 'string' || !(PARAM_TYPES as readonly string[]).includes(type)) {
    return `${where}: type "${String(type)}" di luar daftar TR-069 ("${path}") — salah satu: ${PARAM_TYPES.join(', ')}`;
  }

  const access = p['access'];
  if (typeof access !== 'string' || !(PARAM_ACCESS as readonly string[]).includes(access)) {
    return `${where}: access "${String(access)}" tidak sah ("${path}") — harus read atau readWrite`;
  }

  const group = p['group'];
  if (typeof group !== 'string' || group.trim() === '') return `${where}: group kosong ("${path}")`;

  // unit opsional; kalau ada harus berupa string atau null.
  if ('unit' in p && p['unit'] !== null && typeof p['unit'] !== 'string') {
    return `${where}: unit harus string atau null ("${path}")`;
  }
  return null;
}

/**
 * Validasi struktur katalog. Mengembalikan laporan + salinan katalog yang
 * sudah bersih (entri rusak dibuang, duplikat dihapus).
 */
export function validateCatalog(raw: unknown): {
  report: ValidationReport;
  clean: { version: string; generatedAt: string; sources: string[]; standard: Record<string, unknown[]>; models: unknown[] };
} {
  const fatal: string[] = [];
  const warnings: string[] = [];
  const counts = { tr098: 0, tr181: 0, models: 0, params: 0 };

  const emptyClean = {
    version: '0', generatedAt: '', sources: [] as string[],
    standard: { 'TR-098': [], 'TR-181': [] } as Record<string, unknown[]>,
    models: [] as unknown[],
  };

  if (!isObject(raw)) {
    return {
      report: { ok: false, fatal: ['akar dokumen harus berupa objek JSON'], warnings, counts },
      clean: emptyClean,
    };
  }

  /* ---- standard ---- */
  const stdRaw = raw['standard'];
  if (stdRaw !== undefined && !isObject(stdRaw)) {
    fatal.push('"standard" harus berupa objek, mis. {"TR-098": [...], "TR-181": [...]}');
  }
  const standard: Record<string, unknown[]> = { 'TR-098': [], 'TR-181': [] };
  if (isObject(stdRaw)) {
    for (const [key, list] of Object.entries(stdRaw)) {
      if (!Array.isArray(list)) {
        fatal.push(`standard.${key} harus berupa array`);
        continue;
      }
      const prefix = key === 'TR-098' ? TR098_PREFIX : key === 'TR-181' ? TR181_PREFIX : null;
      const kept: unknown[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < list.length; i++) {
        const where = `standard.${key}[${i}]`;
        const err = checkParam(list[i], where, prefix);
        if (err) { warnings.push(err); continue; }
        const path = (list[i] as { path: string }).path;
        if (seen.has(path)) { warnings.push(`${where}: path duplikat "${path}" diabaikan`); continue; }
        seen.add(path);
        kept.push(list[i]);
      }
      standard[key] = kept;
      if (key === 'TR-098') counts.tr098 = kept.length;
      if (key === 'TR-181') counts.tr181 = kept.length;
    }
  }
  if (!standard['TR-098']?.length && !standard['TR-181']?.length) {
    // Tidak ada standard sama sekali bukan error struktural, tetapi patut
    // dilaporkan: katalog tanpa jalur standard membuat UI hampir kosong.
    warnings.push('tidak ada entri standard sama sekali (TR-098/TR-181 kosong)');
  }

  /* ---- models ---- */
  const modelsRaw = raw['models'];
  const models: unknown[] = [];
  if (modelsRaw !== undefined && !Array.isArray(modelsRaw)) {
    fatal.push('"models" harus berupa array');
  } else if (Array.isArray(modelsRaw)) {
    const seenIds = new Set<string>();
    for (let i = 0; i < modelsRaw.length; i++) {
      const m = modelsRaw[i];
      const where = `models[${i}]`;
      if (!isObject(m)) { warnings.push(`${where}: bukan objek`); continue; }

      const id = m['id'];
      if (typeof id !== 'string' || !id.trim()) { warnings.push(`${where}: id kosong`); continue; }
      if (seenIds.has(id)) { warnings.push(`${where}: id duplikat "${id}"`); continue; }

      const pc = m['productClass'];
      if (pc !== null && pc !== undefined && typeof pc !== 'string') {
        warnings.push(`${where}(${id}): productClass harus string atau null`);
        continue;
      }
      // productClass null DIDUKUNG: umum pada entri vendor pihak ketiga.
      // Pencocokan nanti jatuh ke vendor/alias.

      const paramsRaw = m['params'];
      if (paramsRaw !== undefined && !Array.isArray(paramsRaw)) {
        warnings.push(`${where}(${id}): "params" harus array`);
        continue;
      }

      const kept: unknown[] = [];
      const seen = new Set<string>();
      for (let j = 0; j < (Array.isArray(paramsRaw) ? paramsRaw.length : 0); j++) {
        const err = checkParam(paramsRaw![j], `${where}(${id}).params[${j}]`, null);
        if (err) { warnings.push(err); continue; }
        const path = (paramsRaw![j] as { path: string }).path;
        if (seen.has(path)) { warnings.push(`${where}(${id}): path duplikat "${path}"`); continue; }
        seen.add(path);
        // Param vendor seharusnya menyebut asalnya — tanpa sumber, path sulit
        // dipertanggungjawabkan saat ada yang salah di lapangan.
        if (!(paramsRaw![j] as { source?: string }).source) {
          warnings.push(`${where}(${id}).params(${path}): tanpa field "source" (URL asal)`);
        }
        kept.push(paramsRaw![j]);
        counts.params++;
      }

      seenIds.add(id);
      models.push({ ...m, params: kept });
      counts.models++;
    }
  }

  return {
    report: { ok: fatal.length === 0, fatal, warnings, counts },
    clean: {
      version: typeof raw['version'] === 'string' ? raw['version'] : '0',
      generatedAt: typeof raw['generatedAt'] === 'string' ? raw['generatedAt'] : '',
      sources: Array.isArray(raw['sources'])
        ? (raw['sources'] as unknown[]).filter((s): s is string => typeof s === 'string')
        : [],
      standard,
      models,
    },
  };
}
