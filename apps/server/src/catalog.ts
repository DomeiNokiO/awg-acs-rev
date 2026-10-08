/**
 * Pemuat katalog parameter.
 *
 * File models.json dihasilkan dari riset (lihat packages/catalog/data/).
 * Loader ini defensif: file korup/hilang tidak boleh membuat server mati —
 * UI tetap jalan dengan katalog kosong dan menampilkan peringatan.
 */
import { readFileSync, existsSync, statSync, writeFileSync, renameSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateCatalog } from './catalog-schema.ts';

export interface CatalogParam {
  path: string;
  label: string;
  type: string;
  access: string;
  group: string;
  unit?: string | null;
  vendorExt?: boolean;
  source?: string;
}

export interface CatalogModel {
  id: string;
  vendor: string;
  /** null = entri vendor tanpa productClass; dipasangkan via vendor/alias. */
  productClass: string | null;
  oui?: string | null;
  dataModel: string;
  aliases?: string[];
  notes?: string;
  params: CatalogParam[];
}

export interface Catalog {
  version: string;
  generatedAt: string;
  /** File yang jadi sumber katalog — supaya operator tahu yang termuat apa. */
  source: string;
  sources: string[];
  standard: Record<string, CatalogParam[]>;
  models: CatalogModel[];
  /** true kalau file gagal dimuat dan kita pakai katalog kosong. */
  degraded: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
// Kandidat jalur katalog bawaan. Dari `apps/server/src`, naik ke root repo:
//   naik 3 (src -> server -> apps -> repository root) lalu packages/catalog/data.
const CANDIDATES = [
  join(HERE, '../../../packages/catalog/data/models.json'), // root repo (standar)
  join(HERE, '../../../../packages/catalog/data/models.json'),
  join(HERE, '../../catalog/data/models.json'),
  join(HERE, '../../../catalog/data/models.json'),
  join(process.cwd(), 'packages/catalog/data/models.json'), // fallback cwd
  '/root/acs/packages/catalog/data/models.json',            // dev lokal
];

/** Path file katalog bawaan (yang mana pun ketemu pertama). */
export const CATALOG_FILE: string | null =
  CANDIDATES.find((p) => existsSync(p)) ?? null;

const EMPTY: Catalog = {
  version: '0', generatedAt: '', source: '(kosong)', sources: [],
  standard: { 'TR-098': [], 'TR-181': [] },
  models: [], degraded: true,
};

let cache: Catalog | null = null;
let cacheMtime = 0;

/**
 * Pilih file katalog yang akan dimuat.
 *
 * ACS_CATALOG     ->  menerima path ke FILE json, atau ke
 * DIRECTORI (di dalamnya dicari models.json). Ini penyeru workflow operator
 * yang sudah biasa dengan GenieACS:
 *
 *     git clone https://github.com/.../parameter.git /opt/parameter
 *     ACS_CATALOG=/opt/parameter node apps/server/src/index.ts
 *
 * Berbeda dengan `mongorestore --drop` yang mengganti isi database, di sini
 * file yang ditunjuk menggantikan katalog bawaan secara penuh (semantik
 * ganti, bukan gabung) supaya hasilnya bisa diprediksi.
 *
 * Bila ACS_CATALOG diset tapi tidak ada, KITA TIDAK jatuh ke katalog kosong:
 * file bawaan dipakai dan peringatan dicetak. Operator lebih baik dapat
 * data lama yang salah ketimbang katalog mendadak kosong di tengah operasi.
 */
function resolveCatalogPath(): { path: string | null; source: string } {
  const override = process.env['ACS_CATALOG'];
  if (override) {
    try {
      if (statSync(override).isDirectory()) {
        const inner = join(override, 'models.json');
        if (existsSync(inner)) return { path: inner, source: `ACS_CATALOG(dir) ${override}` };
        console.warn(`[catalog] ACS_CATALOG=${override} tidak berisi models.json, memakai katalog bawaan`);
      } else {
        return { path: override, source: `ACS_CATALOG ${override}` };
      }
    } catch {
      console.warn(`[catalog] ACS_CATALOG=${override} tidak ditemukan, memakai katalog bawaan`);
    }
  }

  const builtin = CANDIDATES.find((p) => existsSync(p));
  return { path: builtin ?? null, source: builtin ? `bawaan ${builtin}` : '(tidak ada)' };
}

// Pemeriksaan per-entri kini ada di catalog-schema.ts (validateCatalog)
// supaya pembacaan file dan endpoint impor memakai aturan yang sama.

export function loadCatalog(force = false): Catalog {
  const { path, source } = resolveCatalogPath();
  if (!path) {
    // Pernah termuat lalu file-nya hilang: tetap pakai isi terakhir agar
    // katalog tidak mendadak kosong di tengah operasi.
    if (cache && !cache.degraded) return cache;
    console.warn('[catalog] models.json tidak ditemukan, memakai katalog kosong');
    cache = EMPTY;
    return cache;
  }

  try {
    const mtime = statSync(path).mtimeMs;
    // Cek mtime inilah yang membuat models.json bisa diperbarui tanpa
    // restart proses. Sebelumnya cabang ini tidak pernah tercapai karena ada
    // `if (cache && !force) return cache` di baris pertama fungsi, sehingga
    // perubahan katalog butuh restart.
    if (cache && !force && mtime === cacheMtime) return cache;

    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const { report, clean } = validateCatalog(raw);

    if (!report.ok) {
      // Struktur rusak: JANGAN menimpa katalog yang sedang berjalan. Mtime
      // tetap dicatat supaya error tidak diulang tiap request — baca ulang
      // hanya terjadi saat filenya berubah.
      console.error(`[catalog] ${path} ditolak, struktur tidak valid:`);
      for (const f of report.fatal) console.error(`  - ${f}`);
      cacheMtime = mtime;
      cache ??= { ...EMPTY, source };
      return cache;
    }

    // Entri individual yang dibuang dilaporkan — kehilangan data katalog
    // harus terlihat, bukan diam-diam.
    if (report.warnings.length) {
      console.warn(`[catalog] ${report.warnings.length} entri tidak valid dibuang:`);
      for (const w of report.warnings.slice(0, 20)) console.warn(`  - ${w}`);
      if (report.warnings.length > 20) console.warn(`  - ... +${report.warnings.length - 20} lainnya`);
    }

    const standard: Record<string, CatalogParam[]> = {
      'TR-098': clean.standard['TR-098'] as CatalogParam[],
      'TR-181': clean.standard['TR-181'] as CatalogParam[],
    };
    for (const [k, v] of Object.entries(clean.standard)) {
      if (!(k in standard)) standard[k] = v as CatalogParam[];
    }

    const models: CatalogModel[] = clean.models.map((rawModel) => {
      const o = rawModel as Record<string, unknown>;
      const pc = typeof o['productClass'] === 'string' && o['productClass']
        ? o['productClass']
        : null;
      if (pc === null) {
        // productClass null umum pada entri vendor pihak ketiga. Tetap muat
        // berdasarkan id/vendor/alias, tapi tandai supaya pencocokan sadar.
        console.warn(`[catalog] model "${String(o['id'])}" tanpa productClass — dipasangkan lewat vendor/alias saja`);
      }
      return {
        id: String(o['id']),
        vendor: typeof o['vendor'] === 'string' ? o['vendor'] : '',
        productClass: pc,
        oui: typeof o['oui'] === 'string' ? o['oui'] : null,
        dataModel: typeof o['dataModel'] === 'string' ? o['dataModel'] : 'TR-098',
        aliases: Array.isArray(o['aliases'])
          ? o['aliases'].filter((a): a is string => typeof a === 'string')
          : [],
        notes: typeof o['notes'] === 'string' ? o['notes'] : '',
        params: (o['params'] as CatalogParam[] | undefined) ?? [],
      };
    });

    cache = {
      version: clean.version,
      generatedAt: clean.generatedAt,
      source,
      sources: clean.sources,
      standard, models, degraded: false,
    };
    cacheMtime = mtime;
    console.log(
      `[catalog] sumber: ${source} — ${standard['TR-098'].length} TR-098, ` +
      `${standard['TR-181'].length} TR-181, ${models.length} model`,
    );
  } catch (err) {
    console.error('[catalog] gagal memuat, memakai katalog kosong:', (err as Error).message);
    cache = EMPTY;
  }
  return cache;
}

/** Cari model yang cocok dengan perangkat, memakai productClass lalu alias. */
export function findModelFor(productClass: string): CatalogModel | null {
  const cat = loadCatalog();
  const pc = productClass.trim();
  if (!pc) return null;
  const direct = cat.models.find((m) => m.productClass === pc);
  if (direct) return direct;
  const lower = pc.toLowerCase();
  return cat.models.find((m) => {
    if (m.aliases?.some((a) => a.toLowerCase() === lower)) return true;
    // productClass boleh null — jangan dipanggil buta.
    if (!m.productClass) return false;
    const mpc = m.productClass.toLowerCase();
    return mpc === lower || lower.includes(mpc);
  }) ?? null;
}

/**
 * File yang menjadi target operasi tulis (impor via API).
 *
 * Mengikuti aturan yang sama dengan resolveCatalogPath supaya impor tidak
 * pernah menulis ke satu file sementara pembacaan membaca file lain —
 * kondisi yang sangat membingungkan saat debugging.
 */
export function catalogWritePath(): string {
  const override = process.env['ACS_CATALOG'];
  if (override) {
    // Sudah ada sebagai direktori -> tulis models.json di dalamnya.
    try {
      if (statSync(override).isDirectory()) return join(override, 'models.json');
    } catch {
      // Tidak ada: anggap sebagai jalur file yang akan dibuat.
    }
    return override;
  }
  return CANDIDATES[0];
}

/**
 * Tulis katalog secara atomik.
 *
 * Tulis ke file sementara lalu rename, supaya proses yang mati di tengah
 * penulisan tidak meninggalkan file JSON separuh jadi yang akan merusak
 * katalog pada pembacaan berikutnya. Salinan lama disimpan sebagai .bak
 * agar operator bisa mundur satu langkah.
 */
export function writeCatalogFile(content: unknown, target: string): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });

  if (existsSync(target)) {
    try { copyFileSync(target, `${target}.bak`); } catch { /* .bak bersifat pelengkap */ }
  }

  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
}
