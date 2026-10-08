#!/usr/bin/env bash
# ============================================================================
# Installer AWG-ACS (TR-069) — Proxmox LXC (CT) / VPS / VM.
#
# Didukung: Ubuntu 22.04 / 24.04, Debian 12 / 13 (Debian 11 EOL: jalan dengan peringatan).
# TANPA Docker: Node.js + Next.js build + SQLite. Satu proses melayani
# CWMP (:7547) + API/UI (:8080). Muat di CT unprivileged 1 vCPU / 1 GB RAM.
#
# Cara pakai:
#   1. Interaktif di dalam CT:
#        curl -fsSL https://raw.githubusercontent.com/DomeiNokiO/awg-acs-rev/main/deploy/install.sh | bash
#   2. Non-interaktif (otomasi) — env var WAJIB di-export di baris terpisah
#      (`VAR=x curl | bash` hanya mengirim VAR ke curl, bukan ke bash):
#        export ACS_NONINTERACTIVE=1 ACS_ADMIN_PASSWORD='Rahasia123' ACS_API_PORT=8080
#        curl -fsSL .../install.sh | bash
#   3. Update ke versi terbaru: jalankan perintah yang sama lagi. Database,
#      .env, dan sertifikat TLS dipertahankan.
#
# Variabel yang dikenali: ACS_ADMIN_PASSWORD, ACS_BIND, ACS_CWMP_PORT,
# ACS_API_PORT, ACS_ENABLE_CWMP/NBI/UI, ACS_ENABLE_TLS, ACS_NONINTERACTIVE,
# REPO_URL, REPO_BRANCH, APP_DIR, DATA_DIR, NODE_MAJOR.
# ============================================================================
# Seluruh script dibungkus satu blok { … }: bash mem-parse blok utuh sebelum
# menjalankannya. Pada `curl | bash`, script dibaca dari stdin — tanpa blok
# ini perintah anak yang membaca stdin (apt, npm, git) bisa "memakan" sisa
# script. Setelah ter-parse, stdin dialihkan ke /dev/null.
{
exec </dev/null
set -Eeuo pipefail
export LC_ALL=C.UTF-8 LANG=C.UTF-8 DEBIAN_FRONTEND=noninteractive NEXT_TELEMETRY_DISABLED=1

REPO_URL="${REPO_URL:-https://github.com/DomeiNokiO/awg-acs-rev.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/acs}"
APP_USER="acs"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
NODE_MAJOR="${NODE_MAJOR:-24}"
# Versi Node minimum yang menjalankan TypeScript tanpa flag + node:sqlite.
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=18
ENV_FILE="$APP_DIR/.env"
LOG_FILE="/var/log/acs-install.log"

: > "$LOG_FILE" 2>/dev/null || LOG_FILE="/tmp/acs-install.log"
trap 'rc=$?; echo "" >&2; echo "[ERROR] Installer gagal (exit $rc) di baris $LINENO: ${BASH_COMMAND}" >&2; echo "        Log lengkap: $LOG_FILE" >&2' ERR

log()  { echo; echo "==> $*"; }
info() { echo "   $*"; }
warn() { echo "   [!] $*" >&2; }
fail() { echo "" >&2; echo "[FATAL] $*" >&2; echo "        Log lengkap: $LOG_FILE" >&2; exit 1; }

# Jalankan perintah panjang: output ke log, tampilkan ekor log bila gagal.
run() {
    local desc="$1"; shift
    if ! "$@" >>"$LOG_FILE" 2>&1; then
        echo "--- 30 baris terakhir log ($desc) ---" >&2
        tail -n 30 "$LOG_FILE" >&2 || true
        fail "$desc gagal"
    fi
}

# String acak alfanumerik. TIDAK memakai `tr </dev/urandom | head`: dengan
# `pipefail`, tr mati oleh SIGPIPE (exit 141) dan installer ikut berhenti.
rand_str() { # $1=panjang
    local s=""
    while (( ${#s} < $1 )); do
        s+="$(head -c 256 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"
    done
    printf '%s' "${s:0:$1}"
}

# --- prompt interaktif via /dev/tty (aman untuk `curl | bash`) --------------
# Uji dengan MEMBUKA /dev/tty, bukan sekadar `-e`: node /dev/tty selalu ada,
# tapi tanpa controlling terminal membukanya gagal "No such device".
has_tty() { [[ -z "${ACS_NONINTERACTIVE:-}" ]] && { : > /dev/tty; } 2>/dev/null; }
ask() { # $1=prompt $2=default
    local answer=""
    printf "%s [%s]: " "$1" "$2" > /dev/tty
    read -r answer < /dev/tty || true
    printf '%s' "${answer:-$2}"
}
ask_secret() { # $1=prompt
    local answer=""
    printf "%s: " "$1" > /dev/tty
    read -rs answer < /dev/tty || true
    echo > /dev/tty
    printf '%s' "$answer"
}
yn() { # $1=prompt $2=default(y/n)
    local a
    a="$(ask "$1 (y/n)" "$2")"
    case "$a" in y|Y|yes|YES|ya|Ya) return 0;; *) return 1;; esac
}
is_port() { [[ "$1" =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 )); }
# Password disimpan di .env (EnvironmentFile systemd) — batasi karakter agar
# tidak ada masalah kutip/spasi/ekspansi.
valid_pass() { [[ "$1" =~ ^[A-Za-z0-9@#%+=:,._-]{8,64}$ ]]; }

# --- prasyarat -------------------------------------------------------------
[[ $EUID -eq 0 ]] || fail "Jalankan sebagai root (sudo -i) — installer memasang paket sistem."
[[ -r /etc/os-release ]] || fail "/etc/os-release tidak ada — distro tidak dikenali."
# shellcheck disable=SC1091
. /etc/os-release
OS_ID="${ID:-}"; OS_LIKE="${ID_LIKE:-}"; OS_VER="${VERSION_ID:-}"
case " $OS_ID $OS_LIKE " in
    *" debian "*|*" ubuntu "*) ;;
    *) fail "Distro '$OS_ID' belum didukung. Gunakan Ubuntu 22.04/24.04 atau Debian 12/13." ;;
esac
case "$OS_ID:$OS_VER" in
    ubuntu:22.04|ubuntu:24.04|debian:12|debian:13) ;;
    debian:11) warn "Debian 11 sudah EOL (LTS berakhir 08/2026) — paket security mulai hilang dari mirror. Disarankan template Debian 12/13." ;;
    *) warn "OS $OS_ID $OS_VER belum diuji (diuji: Ubuntu 22.04/24.04, Debian 12/13). Melanjutkan." ;;
esac
ARCH="$(uname -m)"
case "$ARCH" in x86_64|aarch64) ;; *) fail "Arsitektur $ARCH tidak didukung (butuh x86_64/aarch64)." ;; esac

VIRT="$(systemd-detect-virt -c 2>/dev/null || true)"
HAS_SYSTEMD=0
[[ -d /run/systemd/system ]] && HAS_SYSTEMD=1

# Instalasi ulang: pertahankan konfigurasi lama sebagai default.
EXISTING_ENV=0
if [[ -f "$ENV_FILE" ]]; then
    EXISTING_ENV=1
    # Nilai lama hanya mengisi variabel yang BELUM di-export pengguna.
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
        k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"
        [[ -z "${!k+x}" ]] && printf -v "$k" '%s' "$v"
    done < "$ENV_FILE"
fi
ACS_ENABLE_CWMP="${ACS_ENABLE_CWMP:-1}"
ACS_ENABLE_NBI="${ACS_ENABLE_NBI:-1}"
ACS_ENABLE_UI="${ACS_ENABLE_UI:-1}"
ACS_ENABLE_TLS="${ACS_ENABLE_TLS:-0}"
ACS_BIND="${ACS_BIND:-0.0.0.0}"
ACS_CWMP_PORT="${ACS_CWMP_PORT:-7547}"
ACS_API_PORT="${ACS_API_PORT:-8080}"
ACS_DB="${ACS_DB:-$DATA_DIR/acs.db}"
DB_EXISTED=0
[[ -f "$ACS_DB" ]] && DB_EXISTED=1

# --- konfigurasi interaktif ------------------------------------------------
if has_tty; then
    log "Konfigurasi ACS"
    [[ $EXISTING_ENV == 1 ]] && info "Konfigurasi lama ditemukan ($ENV_FILE) — dipakai sebagai default."
    if [[ $DB_EXISTED == 1 ]]; then
        info "Database lama ditemukan — akun admin & password yang ada TIDAK diubah."
    elif [[ -z "${ACS_ADMIN_PASSWORD:-}" ]]; then
        while :; do
            p="$(ask_secret "Password admin ACS (8-64 karakter, kosong = acak)")"
            if [[ -z "$p" ]] || valid_pass "$p"; then ACS_ADMIN_PASSWORD="$p"; break; fi
            echo "   Password harus 8-64 karakter: huruf, angka, @ # % + = : , . _ -" > /dev/tty
        done
    fi
    yn "Aktifkan CWMP :${ACS_CWMP_PORT} (port TR-069 untuk ONU)?" "$([[ $ACS_ENABLE_CWMP == 1 ]] && echo y || echo n)" \
        && ACS_ENABLE_CWMP=1 || ACS_ENABLE_CWMP=0
    yn "Aktifkan API (NBI) :${ACS_API_PORT}/api?" "$([[ $ACS_ENABLE_NBI == 1 ]] && echo y || echo n)" \
        && ACS_ENABLE_NBI=1 || ACS_ENABLE_NBI=0
    yn "Aktifkan UI web :${ACS_API_PORT}/?" "$([[ $ACS_ENABLE_UI == 1 ]] && echo y || echo n)" \
        && ACS_ENABLE_UI=1 || ACS_ENABLE_UI=0
    yn "Aktifkan TLS self-signed (CWMP+API)?" "$([[ $ACS_ENABLE_TLS == 1 ]] && echo y || echo n)" \
        && ACS_ENABLE_TLS=1 || ACS_ENABLE_TLS=0
    ACS_BIND="$(ask "Bind address" "$ACS_BIND")"
    while :; do ACS_CWMP_PORT="$(ask "Port CWMP" "$ACS_CWMP_PORT")"; is_port "$ACS_CWMP_PORT" && break; echo "   Port tidak valid" > /dev/tty; done
    while :; do ACS_API_PORT="$(ask "Port API/UI" "$ACS_API_PORT")"; is_port "$ACS_API_PORT" && break; echo "   Port tidak valid" > /dev/tty; done
fi

is_port "$ACS_CWMP_PORT" || fail "ACS_CWMP_PORT tidak valid: $ACS_CWMP_PORT"
is_port "$ACS_API_PORT"  || fail "ACS_API_PORT tidak valid: $ACS_API_PORT"
[[ "$ACS_CWMP_PORT" != "$ACS_API_PORT" ]] || fail "Port CWMP dan API tidak boleh sama ($ACS_API_PORT)"

PASS_GENERATED=0
if [[ -z "${ACS_ADMIN_PASSWORD:-}" ]]; then
    ACS_ADMIN_PASSWORD="acs-$(rand_str 12)"
    PASS_GENERATED=1
elif [[ $DB_EXISTED == 0 ]] && ! valid_pass "$ACS_ADMIN_PASSWORD"; then
    fail "ACS_ADMIN_PASSWORD harus 8-64 karakter: huruf, angka, @ # % + = : , . _ -"
fi

# --- paket sistem ----------------------------------------------------------
log "Memasang paket sistem ($OS_ID $OS_VER, $ARCH${VIRT:+, container: $VIRT})"
BASE_PKGS=(ca-certificates curl git gnupg openssl xz-utils tar procps)
run "apt-get update" apt-get update -y
# Coba ulang sekali: mirror yang sedang sinkron sering memberi 404 sesaat.
if ! apt-get install -y --no-install-recommends "${BASE_PKGS[@]}" >>"$LOG_FILE" 2>&1; then
    warn "apt-get install gagal — memperbarui indeks dan mencoba lagi"
    sleep 5
    run "apt-get update" apt-get update -y
    run "apt-get install" apt-get install -y --no-install-recommends --fix-missing "${BASE_PKGS[@]}"
fi

# --- Node.js ----------------------------------------------------------------
node_ok() {
    command -v node >/dev/null 2>&1 || return 1
    local v maj min
    v="$(node -p 'process.versions.node' 2>/dev/null)" || return 1
    maj="${v%%.*}"; min="${v#*.}"; min="${min%%.*}"
    (( maj > NODE_MIN_MAJOR || (maj == NODE_MIN_MAJOR && min >= NODE_MIN_MINOR) ))
}

install_node_nodesource() {
    # Paket nodejs/libnode bawaan Ubuntu bentrok file dengan paket NodeSource.
    apt-get remove -y nodejs libnode-dev 'libnode[0-9]*' nodejs-doc >>"$LOG_FILE" 2>&1 || true
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list
    apt-get update -y && apt-get install -y nodejs
}

install_node_tarball() {
    # Cadangan: biner resmi nodejs.org ke /usr/local (tanpa repo apt).
    local a ver url tmp
    a="x64"; [[ "$ARCH" == aarch64 ]] && a="arm64"
    ver="$(curl -fsSL https://nodejs.org/dist/index.json \
        | grep -o "\"version\":\"v${NODE_MAJOR}\.[0-9.]*\"" | head -n1 | cut -d'"' -f4)" || true
    [[ -n "$ver" ]] || return 1
    url="https://nodejs.org/dist/${ver}/node-${ver}-linux-${a}.tar.xz"
    tmp="$(mktemp -d)"
    curl -fsSL "$url" -o "$tmp/node.tar.xz" \
        && tar -xJf "$tmp/node.tar.xz" -C /usr/local --strip-components=1 --no-same-owner \
        && rm -rf "$tmp"
    hash -r
}

if node_ok; then
    info "Node.js $(node -v) sudah memenuhi syarat (≥ v${NODE_MIN_MAJOR}.${NODE_MIN_MINOR})"
else
    log "Memasang Node.js ${NODE_MAJOR} LTS"
    if ! install_node_nodesource >>"$LOG_FILE" 2>&1 || ! node_ok; then
        warn "Repo NodeSource gagal — memakai biner resmi nodejs.org"
        install_node_tarball >>"$LOG_FILE" 2>&1 || true
    fi
    node_ok || fail "Node.js ≥ ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR} tidak berhasil dipasang"
fi
NODE_BIN="$(command -v node)"
info "Node $(node -v), npm $(npm -v)"

# --- user ------------------------------------------------------------------
log "Menyiapkan user '$APP_USER'"
id -u "$APP_USER" >/dev/null 2>&1 \
    || useradd --system --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"

# --- kode aplikasi ---------------------------------------------------------
log "Mengambil kode ACS ($REPO_URL, branch $REPO_BRANCH)"
# Repo dimiliki user acs, installer berjalan sebagai root: git ≥ 2.35.2
# menolaknya ("dubious ownership") tanpa safe.directory.
GIT=(git -c "safe.directory=$APP_DIR")
if [[ -d "$APP_DIR/.git" ]]; then
    run "git fetch" "${GIT[@]}" -C "$APP_DIR" fetch --depth 1 origin "$REPO_BRANCH"
    run "git reset" "${GIT[@]}" -C "$APP_DIR" reset --hard FETCH_HEAD
else
    if [[ -d "$APP_DIR" ]] && [[ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]]; then
        # Sisa instalasi yang gagal / bukan git: simpan data & .env, sisanya disingkirkan.
        BACKUP="${APP_DIR}.bak-$(date +%Y%m%d%H%M%S)"
        warn "$APP_DIR ada tapi bukan repo git — dipindah ke $BACKUP"
        mv "$APP_DIR" "$BACKUP"
        mkdir -p "$APP_DIR"
        [[ -d "$BACKUP/data" ]] && cp -a "$BACKUP/data" "$APP_DIR/.data-restore"
        [[ -f "$BACKUP/.env" ]] && cp -a "$BACKUP/.env" "$APP_DIR/.env-restore"
        tmpclone="$(mktemp -d)"
        run "git clone" git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$tmpclone/src"
        cp -a "$tmpclone/src/." "$APP_DIR/"
        rm -rf "$tmpclone"
        [[ -d "$APP_DIR/.data-restore" ]] && { mkdir -p "$DATA_DIR"; cp -a "$APP_DIR/.data-restore/." "$DATA_DIR/"; rm -rf "$APP_DIR/.data-restore"; }
        [[ -f "$APP_DIR/.env-restore" ]] && mv "$APP_DIR/.env-restore" "$ENV_FILE"
    else
        run "git clone" git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
    fi
fi
mkdir -p "$DATA_DIR"
info "Versi: $("${GIT[@]}" -C "$APP_DIR" log -1 --format='%h %s' 2>/dev/null | cut -c1-70)"

# --- dependensi + build UI -------------------------------------------------
cd "$APP_DIR"
# RAM efektif = min(MemTotal, batas cgroup di sepanjang hierarki proses ini).
# Di CT Proxmox MemTotal sudah mencerminkan batas (lxcfs); di Docker/cgroup
# lain hanya batas cgroup yang benar — dan batasnya bisa ada di induk.
MEM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
mem_limit_cap() { # $1 = nilai batas (byte) atau "max"
    [[ "$1" =~ ^[0-9]+$ ]] || return 0
    local mb=$(( $1 / 1048576 ))
    (( mb > 0 && (MEM_MB == 0 || mb < MEM_MB) )) && MEM_MB=$mb
    return 0
}
CG_PATH="$(awk -F: '$1=="0" {print $3}' /proc/self/cgroup 2>/dev/null || true)"
if [[ -n "$CG_PATH" && -d /sys/fs/cgroup ]]; then          # cgroup v2
    d="/sys/fs/cgroup${CG_PATH%/}"
    while [[ "$d" == /sys/fs/cgroup* ]]; do
        [[ -r "$d/memory.max" ]] && mem_limit_cap "$(cat "$d/memory.max" 2>/dev/null)"
        [[ "$d" == /sys/fs/cgroup ]] && break
        d="$(dirname "$d")"
    done
elif [[ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]]; then   # cgroup v1
    mem_limit_cap "$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)"
fi
info "RAM efektif: ${MEM_MB} MB"
(( MEM_MB > 0 && MEM_MB < 900 )) && warn "RAM ${MEM_MB} MB — build UI bisa gagal. Disarankan ≥ 1 GB."

log "Memasang dependensi npm (bisa beberapa menit)"
if ! { [[ -f package-lock.json ]] && npm ci --no-audit --no-fund --loglevel=error >>"$LOG_FILE" 2>&1; }; then
    warn "npm ci tidak bisa dipakai — memakai npm install"
    run "npm install" npm install --no-audit --no-fund --loglevel=error
fi

# Turbopack (default Next.js 16) memakai > 1 GB dan di-OOM-kill di CT 1 GB.
# Mode hemat: webpack + satu worker + heap dibatasi — terukur lolos di
# batas cgroup 768 MB maupun 1 GB.
build_lowmem() {
    ACS_BUILD_LOWMEM=1 NODE_OPTIONS="--max-old-space-size=512" \
        npm run build --workspace apps/web -- --webpack
}
build_default() { npm run build --workspace apps/web; }

rm -rf "$APP_DIR/apps/web/.next" "$APP_DIR/apps/web/out"
if (( MEM_MB > 0 && MEM_MB < 3072 )); then
    log "Membangun UI (mode hemat memori, RAM ${MEM_MB} MB — bisa 3-6 menit)"
    run "build UI" build_lowmem
else
    log "Membangun UI (Next.js static export)"
    if ! build_default >>"$LOG_FILE" 2>&1; then
        warn "Build gagal (kemungkinan kehabisan memori) — mengulang dengan mode hemat memori"
        rm -rf "$APP_DIR/apps/web/.next"
        run "build UI" build_lowmem
    fi
fi
[[ -f "$APP_DIR/apps/web/out/index.html" ]] || fail "Build UI tidak menghasilkan apps/web/out/index.html"
rm -rf "$APP_DIR/apps/web/.next"   # cache build ±100 MB, tidak dipakai saat runtime

# --- konfigurasi -----------------------------------------------------------
log "Menulis konfigurasi ($ENV_FILE)"
{
    echo "# AWG-ACS — dibuat installer $(date -Iseconds). Ubah lalu: systemctl restart acs"
    echo "ACS_DB=$ACS_DB"
    echo "ACS_BIND=$ACS_BIND"
    echo "ACS_CWMP_PORT=$ACS_CWMP_PORT"
    echo "ACS_API_PORT=$ACS_API_PORT"
    echo "# Hanya dipakai saat database dibuat pertama kali (akun admin awal)."
    echo "ACS_ADMIN_PASSWORD=$ACS_ADMIN_PASSWORD"
    echo "ACS_ENABLE_CWMP=$ACS_ENABLE_CWMP"
    echo "ACS_ENABLE_NBI=$ACS_ENABLE_NBI"
    echo "ACS_ENABLE_UI=$ACS_ENABLE_UI"
    echo "ACS_ENABLE_TLS=$ACS_ENABLE_TLS"
    echo "ACS_SESSION_TTL=${ACS_SESSION_TTL:-8}"
    echo "ACS_COLLECT_INTERVAL_MIN=${ACS_COLLECT_INTERVAL_MIN:-30}"
    [[ -n "${ACS_CATALOG:-}" ]] && echo "ACS_CATALOG=$ACS_CATALOG"
    [[ -n "${ACS_CWMP_CREDENTIALS:-}" ]] && echo "ACS_CWMP_CREDENTIALS=$ACS_CWMP_CREDENTIALS"
    if [[ "$ACS_ENABLE_TLS" == 1 ]]; then
        echo "ACS_CWMP_TLS_CERT=$DATA_DIR/tls/cwmp.crt"
        echo "ACS_CWMP_TLS_KEY=$DATA_DIR/tls/cwmp.key"
        echo "ACS_API_TLS_CERT=$DATA_DIR/tls/cwmp.crt"
        echo "ACS_API_TLS_KEY=$DATA_DIR/tls/cwmp.key"
    fi
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"

if [[ "$ACS_ENABLE_TLS" == 1 && ! -f "$DATA_DIR/tls/cwmp.crt" ]]; then
    log "Membuat sertifikat TLS self-signed (10 tahun)"
    mkdir -p "$DATA_DIR/tls"
    run "openssl" openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -keyout "$DATA_DIR/tls/cwmp.key" -out "$DATA_DIR/tls/cwmp.crt" -subj "/CN=$(hostname -f 2>/dev/null || hostname)"
    chmod 600 "$DATA_DIR/tls/cwmp.key"
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
[[ "$DATA_DIR" == "$APP_DIR"/* ]] || chown -R "$APP_USER:$APP_USER" "$DATA_DIR"

# Port < 1024 butuh CAP_NET_BIND_SERVICE untuk user non-root.
LOW_PORT=0
(( ACS_CWMP_PORT < 1024 || ACS_API_PORT < 1024 )) && LOW_PORT=1

# --- layanan ---------------------------------------------------------------
if [[ $HAS_SYSTEMD == 1 ]]; then
    log "Memasang systemd unit (acs.service)"
    {
        cat <<EOF
[Unit]
Description=AWG-ACS TR-069 (CWMP + API + UI)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning $APP_DIR/apps/server/src/index.ts
Restart=on-failure
RestartSec=3
LimitNOFILE=65536
NoNewPrivileges=true
EOF
        if (( LOW_PORT )); then
            echo "AmbientCapabilities=CAP_NET_BIND_SERVICE"
            echo "CapabilityBoundingSet=CAP_NET_BIND_SERVICE"
        fi
        # Sandboxing berbasis mount namespace gagal di LXC unprivileged tanpa
        # nesting (status=226/NAMESPACE). Hanya dipasang di VM/bare metal.
        if [[ -z "$VIRT" || "$VIRT" == none ]]; then
            echo "PrivateTmp=true"
            echo "ProtectSystem=full"
            echo "ProtectHome=true"
            echo "ReadWritePaths=$DATA_DIR"
        fi
        cat <<EOF

[Install]
WantedBy=multi-user.target
EOF
    } > /etc/systemd/system/acs.service
    run "systemctl daemon-reload" systemctl daemon-reload
    run "systemctl enable" systemctl enable acs.service
    log "Menjalankan ACS"
    systemctl restart acs.service || true
else
    # Tanpa systemd (mis. container Docker): jalankan di latar belakang.
    warn "systemd tidak aktif — ACS dijalankan di latar belakang (tidak otomatis jalan saat reboot)."
    log "Menjalankan ACS"
    pkill -u "$APP_USER" -f "apps/server/src/index.ts" 2>/dev/null || true
    (
        set -a; . "$ENV_FILE"; set +a
        cd "$APP_DIR"
        # setsid -f: sesi baru, lepas dari terminal installer (tidak ikut
        # mati saat SSH/terminal ditutup).
        setsid -f setpriv --reuid="$APP_USER" --regid="$APP_USER" --init-groups \
            "$NODE_BIN" --disable-warning=ExperimentalWarning apps/server/src/index.ts \
            >> "$DATA_DIR/acs.log" 2>&1 < /dev/null
    )
fi

# --- health check ----------------------------------------------------------
PROTO=http; [[ "$ACS_ENABLE_TLS" == 1 ]] && PROTO=https
HEALTH=0
for _ in $(seq 1 30); do
    if curl -fsSk "$PROTO://127.0.0.1:$ACS_API_PORT/api/health" >/dev/null 2>&1; then HEALTH=1; break; fi
    if [[ $HAS_SYSTEMD == 1 ]] && systemctl is-failed --quiet acs.service; then break; fi
    sleep 1
done
if [[ $HEALTH == 1 ]]; then
    info "Health check API: OK"
elif [[ "$ACS_ENABLE_NBI" == 1 || "$ACS_ENABLE_UI" == 1 ]]; then
    if [[ $HAS_SYSTEMD == 1 ]]; then
        journalctl -u acs -n 30 --no-pager >&2 || true
        fail "ACS tidak merespon di :$ACS_API_PORT. Cek: journalctl -u acs -n 100"
    else
        tail -n 30 "$DATA_DIR/acs.log" >&2 || true
        fail "ACS tidak merespon di :$ACS_API_PORT. Cek: $DATA_DIR/acs.log"
    fi
fi

# --- firewall (bila ufw aktif) ----------------------------------------------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    [[ "$ACS_ENABLE_CWMP" == 1 ]] && ufw allow "$ACS_CWMP_PORT/tcp" >/dev/null 2>&1 || true
    [[ "$ACS_ENABLE_NBI" == 1 || "$ACS_ENABLE_UI" == 1 ]] && ufw allow "$ACS_API_PORT/tcp" >/dev/null 2>&1 || true
    info "ufw: port $ACS_CWMP_PORT dan $ACS_API_PORT dibuka"
fi

# --- ringkasan -------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"; IP="${IP:-<ip-ct>}"
log "INSTALASI SELESAI"
info "UI/API   : $PROTO://$IP:$ACS_API_PORT/"
info "CWMP     : $PROTO://$IP:$ACS_CWMP_PORT/   ← isi sebagai ACS URL di ONU"
if [[ $DB_EXISTED == 1 ]]; then
    info "Login    : akun admin lama (database dipertahankan, password tidak diubah)"
else
    info "Login    : admin / $ACS_ADMIN_PASSWORD"
    [[ $PASS_GENERATED == 1 ]] && info "           (password dibuat acak — simpan sekarang; juga ada di $ENV_FILE)"
fi
info "Database : $ACS_DB"
if [[ $HAS_SYSTEMD == 1 ]]; then
    info "Layanan  : systemctl status acs   |   Log: journalctl -u acs -f"
else
    info "Log      : $DATA_DIR/acs.log"
fi
info "Konfig   : $ENV_FILE (ubah lalu restart layanan)"
info "Update   : bash $APP_DIR/deploy/update.sh   (cek dulu: --check, kembali: --rollback)"
exit 0
}
