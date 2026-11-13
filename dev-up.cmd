@echo off
rem TallyMed local launcher for Windows (development only, fabricated data only).
rem Services from compose.yaml: db (PostgreSQL, pg_isready health check) and web (/healthz). The optional mcp profile is not started.
rem This app has no first-run setup token: the first administrator is created with the bootstrap command (docs/development.md).
setlocal EnableExtensions
cd /d "%~dp0"
title TallyMed dev-up

where docker >nul 2>&1
if errorlevel 1 ( echo Docker is not installed or not on PATH. & goto :fatal )
docker compose version >nul 2>&1
if errorlevel 1 ( echo Docker Compose v2 is required. & goto :fatal )
docker info >nul 2>&1
if errorlevel 1 ( echo The Docker daemon is not running. Start Docker Desktop and try again. & goto :fatal )

:menu
echo.
echo TallyMed dev-up
echo   1) Start
echo   2) Stop (keep data)
echo   3) Logs
echo   4) Restart and update
echo   5) Wipe (delete data)
echo   6) Quit
choice /c 123456 /n /m "Choose: "
if errorlevel 6 goto :quit
if errorlevel 5 ( call :wipe & goto :menu )
if errorlevel 4 ( call :update & goto :menu )
if errorlevel 3 ( call :logs & goto :menu )
if errorlevel 2 ( call :stop & goto :menu )
call :start
goto :menu

:quit
endlocal
exit /b 0

:fatal
echo.
pause
exit /b 1

:start
call :bringup
goto :eof

:stop
docker compose --profile mcp stop
if errorlevel 1 ( echo Stop failed. & pause ) else ( echo Stopped. Data volumes are kept. )
goto :eof

:logs
echo Following logs. Press Ctrl+C, then answer N to the "Terminate batch job" question to return to the menu.
docker compose logs -f --tail=100
goto :eof

:update
call :gitpull
call :bringup
goto :eof

:wipe
echo This deletes the local database and the document volume (all local data) for this project.
set "CONFIRM="
set /p "CONFIRM=Type YES to continue: "
if not "%CONFIRM%"=="YES" ( echo Cancelled. & goto :eof )
docker compose --profile mcp down -v --remove-orphans
if errorlevel 1 ( echo Wipe failed. & pause ) else ( echo Wiped. Your .env file was not touched. )
goto :eof

:gitpull
set "TMPOUT=%TEMP%\tallymed-devup-%RANDOM%.txt"
set "BRANCH="
set "UPSTREAM="
set "DIRTY="
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 ( echo Git: skipped, not a git checkout. & goto :eof )
for /f "delims=" %%b in ('git symbolic-ref -q --short HEAD 2^>nul') do set "BRANCH=%%b"
if not defined BRANCH ( echo Git: skipped, HEAD is detached. & goto :eof )
for /f "delims=" %%u in ('git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2^>nul') do set "UPSTREAM=%%u"
if not defined UPSTREAM ( echo Git: skipped, branch %BRANCH% has no upstream. & goto :eof )
for /f "delims=" %%d in ('git status --porcelain --untracked-files=no') do set "DIRTY=1"
if defined DIRTY ( echo Git: skipped, tracked files have local changes. & goto :eof )
git pull --ff-only > "%TMPOUT%" 2>&1
if errorlevel 1 (
  type "%TMPOUT%"
  echo Git: pull failed on %BRANCH%; continuing with the current checkout.
) else (
  set "FIRST="
  for /f "usebackq delims=" %%l in ("%TMPOUT%") do set "FIRST=%%l"
  call echo Git: %BRANCH% from %UPSTREAM%: %%FIRST%%
)
del "%TMPOUT%" >nul 2>&1
goto :eof

:bringup
set "TMPOUT=%TEMP%\tallymed-devup-%RANDOM%.txt"
if exist .env (
  echo Using existing .env ^(left unchanged^).
) else if exist .env.example (
  copy /-y .env.example .env >nul
  echo Created .env from .env.example ^(local development values^).
) else (
  echo .env.example is missing; cannot create .env. & pause & goto :eof
)
docker compose build --quiet > "%TMPOUT%" 2>&1
if errorlevel 1 ( echo Image build failed: & type "%TMPOUT%" & del "%TMPOUT%" >nul 2>&1 & pause & goto :eof )
echo Starting containers (waits for the database health check)...
docker compose up -d --wait db
if errorlevel 1 ( echo Database did not become healthy. & del "%TMPOUT%" >nul 2>&1 & pause & goto :eof )
docker compose run --rm web node apps/web/cli/migrate.ts > "%TMPOUT%" 2>&1
if errorlevel 1 ( echo Database migration failed: & type "%TMPOUT%" & del "%TMPOUT%" >nul 2>&1 & pause & goto :eof )
del "%TMPOUT%" >nul 2>&1
docker compose up -d --wait
if errorlevel 1 ( echo Containers did not start cleanly. & pause & goto :eof )
set "PORT=3001"
if exist .env for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b /c:"TALLYMED_WEB_PORT=" .env`) do set "PORT=%%b"
set "PORT=%PORT:"=%"
where curl.exe >nul 2>&1
if errorlevel 1 ( echo curl.exe not found; skipping the web health check. & goto :urls )
set /a TRIES=0
<nul set /p "=Waiting for the web app to answer /healthz"
:waitloop
curl.exe -fsS -o nul "http://127.0.0.1:%PORT%/healthz" >nul 2>&1
if not errorlevel 1 ( echo  ok & goto :urls )
set /a TRIES+=1
if %TRIES% geq 60 ( echo. & echo The web app did not become healthy. Choose Logs to see why. & pause & goto :eof )
<nul set /p "=."
ping -n 3 127.0.0.1 >nul
goto :waitloop
:urls
echo.
echo TallyMed is running (fabricated local data only):
echo   App:    http://127.0.0.1:%PORT%
echo   Health: http://127.0.0.1:%PORT%/healthz
echo First administrator: see "Private app database, bootstrap and checks" in docs/development.md (no setup token exists).
goto :eof
