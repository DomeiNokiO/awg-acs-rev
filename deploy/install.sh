#!/usr/bin/env bash
# ============================================================================
# Installer ACS TR-069 — untuk Proxmox LXC (CT) / VPS Debian/Ubuntu ringan.
#
# TANPA Docker: Node.js + Next.js build + SQLite. Satu proses melayani
# CWMP (:7547) + API/UI (:8080). Muat di CT unprivileged 1 vCPU / 1 GB RAM.
#
# Cara pakai:
#   1. Interaktif di dalam CT:
#        curl -fsSL https://raw.githubusercontent.com/DomeiNokiO/awg-acs-rev/refs/heads/main/deploy/install.sh | bash
#   2. Non-interaktif (env vars) — untuk otomasi:
#        export ACS_ADMIN_PASSWORD='***' ACS_BIND='0.0.0.0' ACS_CWMP_PORT=7547 \
#               ACS_API_PORT=8080 ACS_SESSION_TTL=8 \
#               ACS_ENABLE_CWMP=1 ACS_ENABLE_NBI=1 ACS_ENABLE_FS=1 ACS_ENABLE_UI=1
#        curl -fsSL .../install.sh | bash
#
#   PENTING: env var WAJIB di-`export` dulu di baris terpisah (bukan
#   `VAR=x curl | bash`) — pipe membuat VAR hanya masuk ke curl, bukan ke bash.
#
# Pertanyaan yang diajukan (interaktif):
#   - apakah mengaktifkan port CWMP / NBI / FS / UI
#   - user + password login admin (default: admin / acs-admin-<acak>)
#   - port-port & bind address
#   - TLS opsional (self-signed) untuk CWMP/API
#
# Setelah selesai, mencetak ringkasan kredensial & alamat.
# ============================================================================
set -Eeuo pipefail
export LC_ALL=C.UTF-8 LANG=C.UTF-8 DEBIAN_FRONTEND=noninteractive

REPO_URL="${REPO_URL:-https://github.com/DomeiNokiO/awg-acs-rev.git}"
APP_DIR="${APP_DIR:-/opt/acs}"
APP_USER="acs"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
ACS_ENABLE_CWMP="${ACS_ENABLE_CWMP:-1}"
ACS_ENABLE_NBI="${ACS_ENABLE_NBI:-1}"
ACS_ENABLE_FS="${ACS_ENABLE_FS:-1}"
ACS_ENABLE_UI="${ACS_ENABLE_UI:-1}"
ACS_BIND="${ACS_BIND:-0.0.0.0}"
ACS_CWMP_PORT="${ACS_CWMP_PORT:-7547}"
ACS_API_PORT="${ACS_API_PORT:-8080}"
ACS_DB="${ACS_DB:-$DATA_DIR/acs.db}"
ACS_ENABLE_TLS="${ACS_ENABLE_TLS:-0}"
trap 'echo "" >&2; echo "[ERROR] Installer gagal di baris $LINENO: ${BASH_COMMAND}" >&2' ERR

log()  { echo; echo "==> $*"; }
fail() { echo "" >&2; echo "[FATAL] $*" >&2; exit 1; }
info() { echo "   $*"; }

# --- prompt interaktif via /dev/tty (aman utk `curl | bash`) --------------
# Deteksi TTY yang BENAR: coba TULIS ke /dev/tty, bukan sekadar `-e` —
# device node /dev/tty selalu ada di filesystem (juga di ssh non-pty),
# tapi tanpa controlling terminal membukanya gagal "No such device".
tty_guard() { [[ -e /dev/tty ]] && { : > /dev/tty; } 2>/dev/null; }
ask() { # $1=prompt $2=default
    local answer
    tty_guard || fail "Mode interaktif butuh terminal (/dev/tty). Jalankan dengan pty (ssh -t) atau set env var."
    printf "%s [%s]: " "$1" "$2" > /dev/tty
    read -r answer < /dev/tty || true
    printf '%s' "${answer:-$2}"
}
ask_secret() { # $1=prompt
    local answer
    tty_guard
    printf "%s: " "$1" > /dev/tty
    read -rs answer < /dev/tty || true
    echo > /dev/tty
    printf '%s' "$answer"
}
yn() { # $1=prompt $2=default(y/n)
    local a
    a="$(ask "$1 (y/n)" "$2")"
    case "$a" in y|Y|yes|YES) return 0;; *) return 1;; esac
}

# --- deteksi OS / root -----------------------------------------------------
[[ $EUID -eq 0 ]] || fail "Jalankan sebagai root (sudo -i) — installer memasang paket sistem."
. /etc/os-release 2>/dev/null || true

# --- konfigurasi interaktif (bila TTY ada & env tidak diset) ---------------
if [[ -e /dev/tty ]] && tty_guard; then
    log "Konfigurasi ACS"
    if [[ -z "${ACS_ADMIN_PASSWORD:-}" ]]; then
        ACS_ADMIN_PASSWORD="$(ask_secret "Password admin ACS (kosong = acak):")"
    fi
    if ! yn "Aktifkan port CWMP :${ACS_CWMP_PORT}? (TR-069 perangkat)" "$([[ $ACS_ENABLE_CWMP == 1 ]] && echo y || echo n)"; then
        ACS_ENABLE_CWMP=0
    fi
    if ! yn "Aktifkan NBI :${ACS_API_PORT}/api? (REST)" "$([[ $ACS_ENABLE_NBI == 1 ]] && echo y || echo n)"; then
        ACS_ENABLE_NBI=0
    fi
    if ! yn "Aktifkan FS :${ACS_API_PORT}/fs? (file server)" "$([[ $ACS_ENABLE_FS == 1 ]] && echo y || echo n)"; then
        ACS_ENABLE_FS=0
    fi
    if ! yn "Aktifkan UI :${ACS_API_PORT}/? (AdminLTE)" "$([[ $ACS_ENABLE_UI == 1 ]] && echo y || echo n)"; then
        ACS_ENABLE_UI=0
    fi
    if yn "Aktifkan TLS self-signed? (CWMP+API)" "$([[ $ACS_ENABLE_TLS == 1 ]] && echo y || echo n)"; then
        ACS_ENABLE_TLS=1
    fi
    ACS_BIND="$(ask "Bind address" "$ACS_BIND")"
    ACS_CWMP_PORT="$(ask "Port CWMP" "$ACS_CWMP_PORT")"
    ACS_API_PORT="$(ask "Port API/UI" "$ACS_API_PORT")"
fi

# Password wajib: generate bila kosong
if [[ -z "${ACS_ADMIN_PASSWORD:-}" ]]; then
    ACS_ADMIN_PASSWORD="acs-admin-$(tr -dc 'a-zA-Z0-9' </dev/urandom | head -c 12)"
    log "Password admin dibuat otomatis (akan dicetak di akhir)."
fi

# --- paket sistem ----------------------------------------------------------
log "Memasang paket sistem"
case "$ID" in
    debian|ubuntu)
        apt-get update -y
        apt-get install -y --no-install-recommends curl ca-certificates git build-essential python3
        ;;
    alpine)
        apk add --no-cache curl ca-certificates git build-base python3
        ;;
    *)
        fail "Distro tak dikenal: '$ID'. Dukung Debian/Ubuntu/Alpine."
        ;;
esac

# --- Node.js (via NodeSource di Debian/Ubuntu; apk di Alpine) --------------
if ! command -v node >/dev/null 2>&1 || [[ $(node -v 2>/dev/null | sed 's/v//; s/\..*//') -lt 22 ]]; then
    log "Memasang Node.js 22 (LTS)"
    case "$ID" in
        debian|ubuntu)
            curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
                || fail "Gagal setup NodeSource. Cek koneksi internet."
            apt-get install -y nodejs
            ;;
        alpine)
            apk add --no-cache nodejs npm
            ;;
    esac
fi
node -v

# --- user + direktori ------------------------------------------------------
log "Membuat user & direktori"
id -u "$APP_USER" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d "$APP_DIR" "$APP_USER"
# CATATAN: jangan `mkdir -p "$APP_DIR"` ATAU "$DATA_DIR" di sini jika DATA_DIR
# berada di dalam APP_DIR — keduanya membuat direktori induk non-kosong → clone
# fatal "destination path already exists". DATA_DIR dibuat SETELAH clone.

# --- clone / update repo ---------------------------------------------------
log "Mengambil kode ACS ($REPO_URL)"
if [[ -d "$APP_DIR/.git" ]]; then
    git -C "$APP_DIR" fetch --depth 1 origin "$(git -C "$APP_DIR" branch --show-current || echo main)"
    git -C "$APP_DIR" reset --hard "@{u}" 2>/dev/null || git -C "$APP_DIR" pull --ff-only || true
else
    git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi
# Direktori data — dibuat SETELAH clone supaya tidak membuat APP_DIR
# non-kosong lebih dulu (clone menolak direktori yang sudah ada).
mkdir -p "$DATA_DIR"

# --- install dependensi + build UI ----------------------------------------
log "Memasang dependensi npm"
cd "$APP_DIR"
npm install --no-audit --no-fund 2>&1 | tail -3

log "Membangun UI (Next.js static export)"
cd "$APP_DIR/apps/web" && npm run build 2>&1 | tail -5
cd "$APP_DIR"

# --- file env --------------------------------------------------------------
log "Menulis konfigurasi"
ENV_FILE="$APP_DIR/.env"
cat > "$ENV_FILE" <<EOF
# ACS TR-069 — dibuat oleh installer $(date -Iseconds)
ACS_DB=$ACS_DB
ACS_BIND=$ACS_BIND
ACS_CWMP_PORT=$ACS_CWMP_PORT
ACS_API_PORT=$ACS_API_PORT
ACS_ADMIN_PASSWORD=$ACS_ADMIN_PASSWORD
ACS_ENABLE_CWMP=$ACS_ENABLE_CWMP
ACS_ENABLE_NBI=$ACS_ENABLE_NBI
# FS (file server) bukan listener terpisah — di ACS ini file statis UI
# disajikan oleh proses API yang sama. ACS_ENABLE_FS dipertahankan demi
# kompatibilitas konsep GenieACS, efeknya sama dengan ACS_ENABLE_UI.
ACS_ENABLE_FS=$ACS_ENABLE_FS
ACS_ENABLE_UI=$ACS_ENABLE_UI
ACS_SESSION_TTL=8
EOF
chmod 600 "$ENV_FILE"

# TLS self-signed opsional
if [[ "$ACS_ENABLE_TLS" == 1 ]]; then
    log "Membuat sertifikat TLS self-signed (10 tahun)"
    mkdir -p "$DATA_DIR/tls"
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -keyout "$DATA_DIR/tls/cwmp.key" -out "$DATA_DIR/tls/cwmp.crt" \
        -subj "/CN=acs.local" 2>/dev/null \
        || fail "openssl gagal membuat sertifikat"
    cp "$DATA_DIR/tls/cwmp.crt" "$DATA_DIR/tls/api.crt"
    cp "$DATA_DIR/tls/cwmp.key" "$DATA_DIR/tls/api.key"
    cat >> "$ENV_FILE" <<EOF
ACS_CWMP_TLS_CERT=$DATA_DIR/tls/cwmp.crt
ACS_CWMP_TLS_KEY=$DATA_DIR/tls/cwmp.key
ACS_API_TLS_CERT=$DATA_DIR/tls/api.crt
ACS_API_TLS_KEY=$DATA_DIR/tls/api.key
EOF
fi

# --- systemd unit ----------------------------------------------------------
log "Memasang systemd unit (acs)"
cat > /etc/systemd/system/acs.service <<EOF
[Unit]
Description=ACS TR-069 (CWMP + API + UI)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/env node $APP_DIR/apps/server/src/index.ts
Restart=on-failure
RestartSec=3
# Keamanan dasar
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadOnlyPaths=/etc
# Log dibatasi ~16 MB per file
LogRateLimitIntervalSec=30

[Install]
WantedBy=multi-user.target
EOF
chown -R "$APP_USER":"$APP_USER" "$APP_DIR" "$DATA_DIR"
systemctl daemon-reload
systemctl enable acs.service

# --- firewall (opsional, kalau ufw ada) ------------------------------------
if command -v ufw >/dev/null 2>&1; then
    [[ "$ACS_ENABLE_CWMP" == 1 ]] && ufw allow "$ACS_CWMP_PORT/tcp" >/dev/null 2>&1 || true
    [[ "$ACS_ENABLE_NBI" == 1 || "$ACS_ENABLE_UI" == 1 ]] && ufw allow "$ACS_API_PORT/tcp" >/dev/null 2>&1 || true
fi

# --- start + verifikasi ----------------------------------------------------
log "Menjalankan ACS"
systemctl restart acs.service
sleep 2
systemctl is-active --quiet acs.service || fail "Layanan acs tidak aktif. Lihat: journalctl -u acs -n 50"

# Health check API (port berubah sesuai konfigurasi non-default)
if [[ "$ACS_ENABLE_NBI" == 1 || "$ACS_ENABLE_UI" == 1 ]]; then
    if curl -fsS "http://127.0.0.1:$ACS_API_PORT/api/health" >/dev/null 2>&1; then
        info "Health check API: OK"
    else
        info "Health check API belum merespon (mungkin masih boot, coba lagi: systemctl status acs)"
    fi
fi

# --- ringkasan -------------------------------------------------------------
log "INSTALLASI SELESAI ✅"
info "UI/API   : http://<ip-ct>:$ACS_API_PORT/"
info "CWMP     : http://<ip-ct>:$ACS_CWMP_PORT/ (untuk perangkat TR-069)"
[[ "$ACS_ENABLE_TLS" == 1 ]] && info "TLS      : https://<ip-ct>:$ACS_API_PORT/ dan :$ACS_CWMP_PORT (self-signed)"
info "Login    : admin / $(printf '%s' "$ACS_ADMIN_PASSWORD")"
info "Database : $ACS_DB"
info "Log      : journalctl -u acs -f"
echo
info "Untuk mengubah port TLS / konfigurasi lain: edit $ENV_FILE lalu"
info "  systemctl restart acs"
echo
info "TIP impor katalog paimo54:"
info "  git clone https://github.com/paimo54/parameter /opt/parameter"
info "  node $APP_DIR/scripts/bson-to-catalog.mjs /opt/parameter $DATA_DIR/models.json"
info "  lalu set ACS_CATALOG=$DATA_DIR/models.json di $ENV_FILE"