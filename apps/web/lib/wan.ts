/**
 * Penjelasan LastConnectionError (TR-098 WANPPPConnection/WANIPConnection).
 *
 * LastConnectionError adalah RIWAYAT — penyebab putus/gagal TERAKHIR — bukan
 * status saat ini. Banyak firmware (mis. FiberHome) tetap melaporkan
 * "ERROR_NO_ANSWER" walau PPPoE sudah Connected, sehingga error hanya
 * ditampilkan bila koneksi memang tidak tersambung.
 */
const PPP_ERRORS: Record<string, string> = {
  ERROR_NO_ANSWER: 'Server PPPoE (BRAS) tidak menjawab — cek VLAN, kabel/PON, atau BRAS',
  ERROR_AUTHENTICATION_FAILURE: 'Username/password PPPoE ditolak server',
  ERROR_ISP_TIME_OUT: 'Timeout dari sisi ISP',
  ERROR_ISP_DISCONNECT: 'Diputus oleh ISP',
  ERROR_IDLE_DISCONNECT: 'Putus karena idle',
  ERROR_USER_DISCONNECT: 'Diputus pengguna / ACS',
  ERROR_FORCED_DISCONNECT: 'Diputus paksa',
  ERROR_COMMAND_ABORTED: 'Proses koneksi dibatalkan',
  ERROR_SERVER_OUT_OF_RESOURCES: 'Server PPPoE kehabisan sumber daya',
  ERROR_RESTRICTED_LOGON_HOURS: 'Akun dibatasi jam login',
  ERROR_ACCOUNT_DISABLED: 'Akun PPPoE dinonaktifkan',
  ERROR_ACCOUNT_EXPIRED: 'Akun PPPoE kedaluwarsa',
  ERROR_PASSWORD_EXPIRED: 'Password PPPoE kedaluwarsa',
  ERROR_NOT_ENABLED_FOR_INTERNET: 'Akun tidak diizinkan akses internet',
  ERROR_NO_CARRIER: 'Tidak ada link fisik (PON/LAN)',
  ERROR_NO_DIALTONE: 'Tidak ada link',
  ERROR_IP_CONFIGURATION: 'Gagal mendapatkan konfigurasi IP',
  ERROR_INVALID_DOMAIN_NAME: 'Nama domain tidak valid',
  ERROR_UNKNOWN: 'Penyebab tidak diketahui',
};

const NONE = /^(ERROR_NONE|NONE|NO_ERROR|0)?$/i;
const CONNECTED = /^(connected|up)$/i;

/** Error yang perlu ditampilkan untuk koneksi ini, atau null. */
export function connectionError(status: string | null, lastError: string | null): { code: string; text: string } | null {
  if (!lastError || NONE.test(lastError.trim())) return null;
  if (status && CONNECTED.test(status.trim())) return null; // hanya riwayat
  const code = lastError.trim();
  return { code, text: PPP_ERRORS[code.toUpperCase()] ?? code };
}
