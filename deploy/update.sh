#!/usr/bin/env bash
# ============================================================================
# Update AWG-ACS ke commit terbaru — untuk instalasi dari deploy/install.sh.
#
# Cara pakai (di dalam CT, sebagai root):
#   bash /opt/acs/deploy/update.sh              # update ke commit terbaru
#   bash /opt/acs/deploy/update.sh --check      # cek ada update, tanpa mengubah apa pun
#   bash /opt/acs/deploy/update.sh --force      # paksa install ulang dependensi + build UI
#   bash /opt/acs/deploy/update.sh --rollback   # kembali ke commit sebelum update terakhir
#   curl -fsSL https://raw.githubusercontent.com/DomeiNokiO/awg-acs-rev/main/deploy/update.sh | bash
#
# Yang dilakukan:
#   1. git fetch; tampilkan commit lama → baru dan daftar perubahan
#   2. npm ci  — hanya bila package.json / package-lock.json berubah
#   3. build UI — hanya bila kode UI (apps/web) berubah
#      (build berjalan selagi ACS tetap melayani ONU)
#   4. stop layanan → backup database (data/backup/, simpan 5 terakhir) → start
#   5. health check /api/health; GAGAL → otomatis rollback ke commit lama
#
# Database, .env, dan sertifikat TLS tidak disentuh (di luar kendali git).
# Migrasi skema DB berjalan otomatis saat ACS start dan hanya menambah kolom.
# ============================================================================

# Satu blok { … }: bash mem-parse seluruh script sebelum menjalankannya, jadi
# aman walau `git reset` menimpa file ini sendiri di tengah proses, dan aman
# untuk `curl | bash` (perintah anak tidak "memakan" sisa script dari stdin).
{
exec </dev/null
set -Eeuo pipefail
export LC_ALL=C.UTF-8 LANG=C.UTF-8 NEXT_TELEMETRY_DISABLED=1

APP_DIR="${APP_DIR:-/opt/acs}"
APP_USER="acs"
SERVICE="acs"
LOG_FILE="/var/log/acs-update.log"
MODE="update"
for a in "$@"; do
    case "$a" in
        --check) MODE="check" ;;
        --force) MODE="force" ;;
        --rollback) MODE="rollback" ;;
        --help|-h) sed -n '2,25p' "$0" 2>/dev/null || true; exit 0 ;;
        *) echo "Opsi tidak dikenal: $a (pakai --check | --force | --rollback)" >&2; exit 2 ;;
    esac
done

: > "$LOG_FILE" 2>/dev/null || LOG_FILE="/tmp/acs-update.log"
log()  { echo; echo "==> $*"; }
info() { echo "   $*"; }
warn() { echo "   [!] $*" >&2; }
fail() { echo "" >&2; echo "[FATAL] $*" >&2; echo "        Log: $LOG_FILE" >&2; exit 1; }
run() { # $1=deskripsi, sisanya perintah; output ke log, ekor log bila gagal
    local d="$1"; shift
    if ! "$@" >>"$LOG_FILE" 2>&1; then
        echo "--- 30 baris terakhir log ($d) ---" >&2
        tail -n 30 "$LOG_FILE" >&2 || true
        return 1
    fi
}

[[ $EUID -eq 0 ]] || fail "Jalankan sebagai root (sudo -i)."
[[ -d "$APP_DIR/.git" ]] || fail "$APP_DIR bukan instalasi git. Pasang dulu dengan deploy/install.sh."
cd "$APP_DIR"

# Repo dimiliki user acs, script berjalan sebagai root (git ≥ 2.35.2 menolak
# tanpa safe.directory).
GIT=(git -c "safe.directory=$APP_DIR" -C "$APP_DIR")
BRANCH="${REPO_BRANCH:-$("${GIT[@]}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
[[ "$BRANCH" == HEAD ]] && BRANCH=main

# Port API dari .env untuk health check.
API_PORT=8080; PROTO=http; DATA_DIR="$APP_DIR/data"; DB_FILE=""
if [[ -f "$APP_DIR/.env" ]]; then
    API_PORT="$(sed -n 's/^ACS_API_PORT=//p' "$APP_DIR/.env" | tail -n1)"; API_PORT="${API_PORT:-8080}"
    [[ "$(sed -n 's/^ACS_API_TLS_CERT=//p' "$APP_DIR/.env" | tail -n1)" != "" ]] && PROTO=https
    DB_FILE="$(sed -n 's/^ACS_DB=//p' "$APP_DIR/.env" | tail -n1)"
fi
DB_FILE="${DB_FILE:-$DATA_DIR/acs.db}"
STATE_FILE="$DATA_DIR/.update-previous"
HAS_SYSTEMD=0; [[ -d /run/systemd/system ]] && systemctl cat "$SERVICE" >/dev/null 2>&1 && HAS_SYSTEMD=1

# --- utilitas build (sama dengan installer) ---------------------------------
mem_mb() {
    local mb lim d cg
    mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
    cg="$(awk -F: '$1=="0" {print $3}' /proc/self/cgroup 2>/dev/null || true)"
    if [[ -n "$cg" ]]; then
        d="/sys/fs/cgroup${cg%/}"
        while [[ "$d" == /sys/fs/cgroup* ]]; do
            lim="$(cat "$d/memory.max" 2>/dev/null || echo max)"
            [[ "$lim" =~ ^[0-9]+$ ]] && (( lim / 1048576 < mb || mb == 0 )) && mb=$(( lim / 1048576 ))
            [[ "$d" == /sys/fs/cgroup ]] && break
            d="$(dirname "$d")"
        done
    fi
    echo "$mb"
}

deps_install() {
    log "Memasang dependensi npm"
    if ! npm ci --no-audit --no-fund --loglevel=error >>"$LOG_FILE" 2>&1; then
        warn "npm ci gagal — memakai npm install"
        run "npm install" npm install --no-audit --no-fund --loglevel=error
    fi
}

build_ui() {
    local mb; mb="$(mem_mb)"
    rm -rf "$APP_DIR/apps/web/.next"
    if (( mb > 0 && mb < 3072 )); then
        log "Membangun UI (mode hemat memori, RAM ${mb} MB — bisa 3-6 menit)"
        ACS_BUILD_LOWMEM=1 NODE_OPTIONS="--max-old-space-size=512" \
            run "build UI" npm run build --workspace apps/web -- --webpack
    else
        log "Membangun UI"
        run "build UI" npm run build --workspace apps/web \
            || { rm -rf "$APP_DIR/apps/web/.next"; ACS_BUILD_LOWMEM=1 NODE_OPTIONS="--max-old-space-size=512" \
                run "build UI (hemat memori)" npm run build --workspace apps/web -- --webpack; }
    fi
    [[ -f "$APP_DIR/apps/web/out/index.html" ]] || return 1
    rm -rf "$APP_DIR/apps/web/.next"
}

service_restart() {
    if (( HAS_SYSTEMD )); then
        systemctl restart "$SERVICE" || true
    else
        pkill -u "$APP_USER" -f "apps/server/src/index.ts" 2>/dev/null || true
        sleep 1
        ( set -a; . "$APP_DIR/.env"; set +a; cd "$APP_DIR"
          setsid -f setpriv --reuid="$APP_USER" --regid="$APP_USER" --init-groups \
            "$(command -v node)" --disable-warning=ExperimentalWarning apps/server/src/index.ts \
            >> "$DATA_DIR/acs.log" 2>&1 < /dev/null )
    fi
}

healthy() {
    for _ in $(seq 1 30); do
        curl -fsSk "$PROTO://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1 && return 0
        (( HAS_SYSTEMD )) && systemctl is-failed --quiet "$SERVICE" && return 1
        sleep 1
    done
    return 1
}

backup_db() {
    [[ -f "$DB_FILE" ]] || return 0
    local dir="$DATA_DIR/backup" ts; ts="$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$dir"
    # Layanan sudah berhenti → file DB + WAL konsisten untuk disalin.
    for ext in "" "-wal" "-shm"; do
        [[ -f "$DB_FILE$ext" ]] && cp -a "$DB_FILE$ext" "$dir/acs-$ts-${OLD:0:7}.db$ext"
    done
    # simpan 5 backup terakhir
    ls -1t "$dir"/acs-*.db 2>/dev/null | tail -n +6 | while read -r f; do rm -f "$f" "$f-wal" "$f-shm"; done
    info "Backup database: $dir/acs-$ts-${OLD:0:7}.db"
}

# Ganti kode ke commit $1 lalu pasang dependensi/build bila perlu dibanding $2.
apply_commit() { # $1=commit tujuan $2=commit asal $3=force(0/1)
    local to="$1" from="$2" force="$3" changed
    changed="$("${GIT[@]}" diff --name-only "$from" "$to" 2>/dev/null || echo '*')"
    run "git reset" "${GIT[@]}" reset --hard "$to" || return 1
    if (( force )) || grep -qE '^(package(-lock)?\.json|apps/[^/]+/package\.json|packages/[^/]+/package\.json)$|^\*$' <<<"$changed" \
        || [[ ! -d "$APP_DIR/node_modules" ]]; then
        deps_install || return 1
    else
        info "Dependensi tidak berubah — npm ci dilewati"
    fi
    if (( force )) || grep -qE '^apps/web/|^\*$' <<<"$changed" || [[ ! -f "$APP_DIR/apps/web/out/index.html" ]]; then
        build_ui || return 1
    else
        info "Kode UI tidak berubah — build UI dilewati"
    fi
    chown -R "$APP_USER:$APP_USER" "$APP_DIR"
}

trap 'echo "" >&2; echo "[ERROR] update gagal di baris $LINENO: ${BASH_COMMAND}" >&2; echo "        Log: $LOG_FILE" >&2' ERR

OLD="$("${GIT[@]}" rev-parse HEAD)"

# --- rollback manual -----------------------------------------------------------
if [[ "$MODE" == rollback ]]; then
    PREV="$(cat "$STATE_FILE" 2>/dev/null || true)"
    [[ -n "$PREV" ]] || fail "Tidak ada catatan commit sebelumnya ($STATE_FILE)."
    "${GIT[@]}" cat-file -e "$PREV^{commit}" 2>/dev/null \
        || run "git fetch" "${GIT[@]}" fetch --depth 50 origin "$BRANCH" \
        || fail "Commit $PREV tidak tersedia"
    "${GIT[@]}" cat-file -e "$PREV^{commit}" 2>/dev/null || fail "Commit $PREV tidak tersedia di repo lokal"
    log "Rollback ${OLD:0:7} → ${PREV:0:7}"
    apply_commit "$PREV" "$OLD" 0 || fail "Rollback gagal"
    (( HAS_SYSTEMD )) && systemctl stop "$SERVICE" || true
    backup_db
    service_restart
    healthy || fail "ACS tidak sehat setelah rollback — cek: journalctl -u $SERVICE -n 100"
    echo "$OLD" > "$STATE_FILE"
    log "ROLLBACK SELESAI — sekarang di $("${GIT[@]}" log -1 --format='%h %s' | cut -c1-80)"
    exit 0
fi

# --- cek versi baru ---------------------------------------------------------
log "Memeriksa update ($BRANCH)"
# Kedalaman cukup untuk diff & rollback; repo instalasi awalnya --depth 1.
run "git fetch" "${GIT[@]}" fetch --depth 50 origin "$BRANCH" || fail "git fetch gagal — cek koneksi internet"
NEW="$("${GIT[@]}" rev-parse FETCH_HEAD)"
info "Terpasang : $("${GIT[@]}" log -1 --format='%h %ad %s' --date=short "$OLD" | cut -c1-90)"
info "Terbaru   : $("${GIT[@]}" log -1 --format='%h %ad %s' --date=short "$NEW" | cut -c1-90)"

if [[ "$OLD" == "$NEW" && "$MODE" != force ]]; then
    log "Sudah versi terbaru — tidak ada yang diubah."
    exit 0
fi
if [[ "$OLD" != "$NEW" ]]; then
    echo
    info "Perubahan:"
    "${GIT[@]}" log --format='     %h %s' "$OLD..$NEW" 2>/dev/null | head -n 20 || true
fi
if [[ "$MODE" == check ]]; then
    log "Ada update. Jalankan tanpa --check untuk memasang."
    exit 0
fi

# --- pasang -----------------------------------------------------------------
FORCE=0; [[ "$MODE" == force ]] && FORCE=1
if ! apply_commit "$NEW" "$OLD" "$FORCE"; then
    warn "Pemasangan commit baru gagal — mengembalikan kode ${OLD:0:7} (layanan belum di-restart)"
    apply_commit "$OLD" "$NEW" 0 || true
    fail "Update dibatalkan; ACS tetap berjalan dengan versi lama"
fi

log "Restart layanan"
(( HAS_SYSTEMD )) && systemctl stop "$SERVICE" || true
backup_db
service_restart
if ! healthy; then
    warn "ACS tidak sehat setelah update — rollback otomatis ke ${OLD:0:7}"
    (( HAS_SYSTEMD )) && journalctl -u "$SERVICE" -n 20 --no-pager >&2 || true
    apply_commit "$OLD" "$NEW" 0 || fail "Rollback gagal — perbaiki manual: cd $APP_DIR && git reset --hard $OLD"
    service_restart
    healthy || fail "ACS tetap tidak sehat setelah rollback — cek: journalctl -u $SERVICE -n 100"
    fail "Update ke ${NEW:0:7} gagal dan sudah dikembalikan ke ${OLD:0:7}. Log: $LOG_FILE"
fi
echo "$OLD" > "$STATE_FILE"
chown "$APP_USER:$APP_USER" "$STATE_FILE" 2>/dev/null || true

log "UPDATE SELESAI"
info "Versi    : $("${GIT[@]}" log -1 --format='%h %s' | cut -c1-80)"
info "Rollback : bash $APP_DIR/deploy/update.sh --rollback"
(( HAS_SYSTEMD )) && info "Log      : journalctl -u $SERVICE -f"
exit 0
}
