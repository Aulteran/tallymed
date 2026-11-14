#!/usr/bin/env bash
# TallyMed local launcher (development only, fabricated data only).
# Starts the Compose stack from compose.yaml: PostgreSQL (db, health check pg_isready) and the web app (web, /healthz).
# The optional `mcp` profile is not started here; see docs/mcp.md. Usage: ./dev-up.sh [start|stop|logs|update|wipe]
# First-run setup: while no administrator exists, the launcher generates a one-time setup token, hands it to the web container for
# this start only and prints it on screen once. It is never written to .env, a log or a temporary file. If you define
# TALLYMED_SETUP_TOKEN yourself (.env or environment) that value is used and not displayed.
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
  ensure_secrets_key
}

# The key that encrypts an SMTP password saved in the app. Generated once into the local .env, never printed.
ensure_secrets_key() {
  grep -Eq '^TALLYMED_SECRETS_KEY=[^[:space:]]' .env 2>/dev/null && return 0
  local key tmp
  key=$(head -c 32 /dev/urandom | base64 | tr -d '\n') || return 0
  tmp=$(mktemp) || return 0
  { grep -v '^TALLYMED_SECRETS_KEY=' .env; printf 'TALLYMED_SECRETS_KEY=%s\n' "$key"; } > "$tmp" && cat "$tmp" > .env
  rm -f "$tmp"
  echo "Generated a local TALLYMED_SECRETS_KEY in .env."
}

web_port() {
  local p
  p=$(grep -E '^TALLYMED_WEB_PORT=' .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '\r"' | tr -d "'")
  printf '%s' "${p:-3001}"
}

git_pull() {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "Git: skipped, not a git checkout."; return 0; fi
  local branch up out old new
  branch=$(git symbolic-ref -q --short HEAD) || { echo "Git: skipped, HEAD is detached."; return 0; }
  up=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null) || { echo "Git: skipped, branch '$branch' has no upstream."; return 0; }
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "Git: skipped, tracked files have local changes."; return 0; fi
  old=$(git rev-parse HEAD)
  echo "Pulling $branch from $up..."
  # The full git output stays hidden unless the pull fails.
  if ! out=$(GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=8 git pull --ff-only --quiet 2>&1); then
    printf '%s\n' "$out" >&2; echo "Git: pull failed on '$branch' (offline?); continuing with the current checkout."; return 0
  fi
  new=$(git rev-parse HEAD)
  if [ "$old" = "$new" ]; then echo "Git: already up to date ($(git rev-parse --short HEAD))."; return 0; fi
  echo "Git: updated $(git rev-parse --short "$old")..$(git rev-parse --short "$new") ($(git rev-list --count "$old..$new") commits)"
  # Concise summary of the changed files: first 25 lines of the diffstat, then the totals line.
  local stat; stat=$(git diff --stat=78 "$old" "$new")
  printf '%s\n' "$stat" | head -n 25 | sed 's/^/  /'
  if [ "$(printf '%s\n' "$stat" | wc -l)" -gt 26 ]; then
    echo "  ... and $(( $(printf '%s\n' "$stat" | wc -l) - 26 )) more files"
  fi
  [ "$(printf '%s\n' "$stat" | wc -l)" -gt 25 ] && printf '%s\n' "$stat" | tail -n 1 | sed 's/^/  /'
  return 0
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

# Prints 0 when no administrator exists yet, the count otherwise, and nothing when the database cannot be queried.
admin_count() {
  docker compose exec -T db psql -U tallymed -d tallymed -tAc 'select count(*) from bootstrap_state' 2>/dev/null | tr -d '[:space:]'
}

# True when the operator defined TALLYMED_SETUP_TOKEN in the environment or in .env.
setup_token_defined() {
  [ -n "${TALLYMED_SETUP_TOKEN:-}" ] && return 0
  grep -Eq '^TALLYMED_SETUP_TOKEN=[^[:space:]]' .env 2>/dev/null
}

bring_up() {
  ensure_env || return 1
  echo "Building images (the build log is shown only if it fails)..."
  quiet "Image build" docker compose build --quiet || return 1
  echo "Starting containers (waits for the database health check)..."
  quiet "Database start" docker compose up -d --wait db || return 1
  echo "Applying database migrations..."
  quiet "Database migration" docker compose run --rm web node apps/web/cli/migrate.ts || return 1
  # The token lives only in this variable and in the environment of the one compose command below.
  local setup=unknown token=""
  case $(admin_count) in
    0) setup=needed ;;
    ?*) setup=done ;;
  esac
  if [ "$setup" = needed ] && ! setup_token_defined; then
    token=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40)
  fi
  if [ -n "$token" ]; then
    quiet "Container start" env TALLYMED_SETUP_TOKEN="$token" docker compose up -d --wait || return 1
  else
    quiet "Container start" docker compose up -d --wait || return 1
  fi
  local port; port=$(web_port)
  wait_web "$port" || return 1
  echo
  echo "TallyMed is running (fabricated local data only):"
  echo "  App:    http://127.0.0.1:$port"
  echo "  Health: http://127.0.0.1:$port/healthz"
  case $setup in
    needed)
      echo
      echo "First-time setup: no administrator exists yet. Open http://127.0.0.1:$port/setup and enter the setup token."
      if [ -n "$token" ]; then
        echo "  Setup token (shown once, not saved anywhere): $token"
        echo "  Choose Start again for a new token while setup is still needed."
      else
        echo "  The token is the TALLYMED_SETUP_TOKEN value you defined in .env or your environment."
      fi ;;
    done) echo "An administrator already exists. Sign in at http://127.0.0.1:$port/login (no setup token is needed or shown)." ;;
    *)    echo "Could not tell whether setup is still needed. If the sign-in page says Setup required, choose Logs (3): the server prints its setup token there." ;;
  esac
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
