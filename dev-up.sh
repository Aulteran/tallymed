#!/usr/bin/env bash
# TallyMed local launcher (development only, fabricated data only).
# Starts the Compose stack from compose.yaml: PostgreSQL (db, health check pg_isready) and the web app (web, /healthz).
# The optional `mcp` profile is not started here; see docs/mcp.md. Usage: ./dev-up.sh [start|stop|logs|update|wipe]
# This app has no first-run setup token: the first administrator is created with the bootstrap command
# (passphrase on stdin, see docs/development.md), so the launcher has nothing to display or record for that.
set -u
cd "$(dirname "$0")" || exit 1

die() { printf '%s\n' "$*" >&2; }

preflight() {
  command -v docker >/dev/null 2>&1 || { die "Docker is not installed or not on PATH."; return 1; }
  docker compose version >/dev/null 2>&1 || { die "Docker Compose v2 is required ('docker compose')."; return 1; }
  docker info >/dev/null 2>&1 || { die "The Docker daemon is not running. Start Docker and try again."; return 1; }
}

ensure_env() {
  if [ -e .env ]; then
    echo "Using existing .env (left unchanged)."
  elif [ -f .env.example ]; then
    cp .env.example .env && echo "Created .env from .env.example (local development values)."
  else
    die ".env.example is missing; cannot create .env."; return 1
  fi
}

web_port() {
  local p
  p=$(grep -E '^TALLYMED_WEB_PORT=' .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '\r"' | tr -d "'")
  printf '%s' "${p:-3001}"
}

git_pull() {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "Git: skipped, not a git checkout."; return 0; fi
  local branch up out
  branch=$(git symbolic-ref -q --short HEAD) || { echo "Git: skipped, HEAD is detached."; return 0; }
  up=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null) || { echo "Git: skipped, branch '$branch' has no upstream."; return 0; }
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "Git: skipped, tracked files have local changes."; return 0; fi
  if out=$(git pull --ff-only 2>&1); then
    echo "Git: $branch from $up: $(printf '%s\n' "$out" | tail -n 1)"
  else
    printf '%s\n' "$out" >&2; echo "Git: pull failed on '$branch'; continuing with the current checkout."
  fi
}

# Runs a command quietly; prints its output only when it fails.
quiet() {
  local label=$1 out; shift
  if out=$("$@" 2>&1); then return 0; fi
  die "$label failed:"; printf '%s\n' "$out" >&2; return 1
}

wait_web() {
  local port=$1 i
  command -v curl >/dev/null 2>&1 || { echo "curl not found; skipping the web health check."; return 0; }
  printf 'Waiting for the web app to answer /healthz'
  for i in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$port/healthz" 2>/dev/null; then echo " ok"; return 0; fi
    printf '.'; sleep 2
  done
  echo; die "The web app did not become healthy. Run option 3 (logs) to see why."; return 1
}

bring_up() {
  ensure_env || return 1
  quiet "Image build" docker compose build --quiet || return 1
  echo "Starting containers (waits for the database health check)..."
  docker compose up -d --wait db || { die "Database did not become healthy."; return 1; }
  quiet "Database migration" docker compose run --rm web node apps/web/cli/migrate.ts || return 1
  docker compose up -d --wait || { die "Containers did not start cleanly."; return 1; }
  local port; port=$(web_port)
  wait_web "$port" || return 1
  echo
  echo "TallyMed is running (fabricated local data only):"
  echo "  App:    http://127.0.0.1:$port"
  echo "  Health: http://127.0.0.1:$port/healthz"
  echo "First administrator: see 'Private app database, bootstrap and checks' in docs/development.md (no setup token exists)."
}

do_start()   { preflight && bring_up; }
do_stop()    { preflight && docker compose --profile mcp stop && echo "Stopped. Data volumes are kept."; }
do_logs()    { preflight && { echo "Following logs; press Ctrl+C to return."; docker compose logs -f --tail=100 || true; }; }
do_update()  { preflight || return 1; git_pull; bring_up; }
do_wipe() {
  preflight || return 1
  echo "This deletes the local database and the document volume (all local data) for this project."
  local a; read -r -p "Type YES to continue: " a
  [ "$a" = "YES" ] || { echo "Cancelled."; return 0; }
  docker compose --profile mcp down -v --remove-orphans && echo "Wiped. Your .env file was not touched."
}

dispatch() {
  case $1 in
    1|start) do_start ;; 2|stop) do_stop ;; 3|logs) do_logs ;;
    4|update|restart) do_update ;; 5|wipe) do_wipe ;; 6|q|quit) exit 0 ;;
    *) echo "Unknown choice." ;;
  esac
}

if [ $# -gt 0 ]; then dispatch "$1"; exit $?; fi
while true; do
  printf '\nTallyMed dev-up\n  1) Start\n  2) Stop (keep data)\n  3) Logs\n  4) Restart and update\n  5) Wipe (delete data)\n  6) Quit\n'
  read -r -p "Choose: " c || exit 0
  dispatch "$c"
done
