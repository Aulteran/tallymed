@echo off
rem TallyMed local launcher for Windows (development only, fabricated data only).
rem Services from compose.yaml: db (PostgreSQL, pg_isready health check) and web (/healthz). The optional mcp profile is not started.
rem First-run setup: while no administrator exists, the launcher generates a one-time setup token, hands it to the web container for this
rem start only and prints it on screen once. It is never written to .env, a log or a temporary file. If you define TALLYMED_SETUP_TOKEN
rem yourself (.env or environment) that value is used and not displayed.
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
set "CHOICE="
set /p "CHOICE=Choose (then press Enter): "
if "%CHOICE%"=="6" goto :quit
if /i "%CHOICE%"=="q" goto :quit
if "%CHOICE%"=="5" ( call :wipe & goto :menu )
if "%CHOICE%"=="4" ( call :update & goto :menu )
if "%CHOICE%"=="3" ( call :logs & goto :menu )
if "%CHOICE%"=="2" ( call :stop & goto :menu )
if "%CHOICE%"=="1" ( call :start & goto :menu )
echo Unknown choice. Type a number from 1 to 6 and press Enter.
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
for /f "delims=" %%h in ('git rev-parse HEAD') do set "OLDHEAD=%%h"
echo Pulling %BRANCH% from %UPSTREAM%...
rem The full git output stays hidden unless the pull fails.
git pull --ff-only --quiet > "%TMPOUT%" 2>&1
if errorlevel 1 (
  type "%TMPOUT%"
  echo Git: pull failed on %BRANCH% ^(offline?^); continuing with the current checkout.
  del "%TMPOUT%" >nul 2>&1
  goto :eof
)
del "%TMPOUT%" >nul 2>&1
for /f "delims=" %%h in ('git rev-parse HEAD') do set "NEWHEAD=%%h"
if "%OLDHEAD%"=="%NEWHEAD%" ( echo Git: already up to date. & goto :eof )
for /f "delims=" %%c in ('git rev-list --count %OLDHEAD%..%NEWHEAD%') do set "NCOMMITS=%%c"
echo Git: updated %OLDHEAD:~0,7%..%NEWHEAD:~0,7% ^(%NCOMMITS% commits^)
rem Concise summary of the changed files: the diffstat, first 25 file lines, then the totals line.
set "STATN=0"
set "STATLAST="
for /f "delims=" %%l in ('git diff --stat %OLDHEAD% %NEWHEAD%') do call :statline "%%l"
if %STATN% gtr 26 echo   ... %STATN% diffstat lines in all; showing the first 25.
if %STATN% gtr 25 echo   %STATLAST%
goto :eof

:statline
set /a STATN+=1
set "STATLAST=%~1"
if %STATN% leq 25 echo   %~1
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
findstr /b /r /c:"TALLYMED_SECRETS_KEY=[^ ]" .env >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "$b=New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); $k=[Convert]::ToBase64String($b); $f=@(Get-Content .env | Where-Object { $_ -notmatch '^TALLYMED_SECRETS_KEY=' }); $f + ('TALLYMED_SECRETS_KEY=' + $k) | Set-Content -Encoding ascii .env"
  echo Generated a local TALLYMED_SECRETS_KEY in .env.
)
echo Building images ^(the build log is shown only if it fails^)...
docker compose build --quiet > "%TMPOUT%" 2>&1
if errorlevel 1 ( echo Image build failed: & type "%TMPOUT%" & del "%TMPOUT%" >nul 2>&1 & pause & goto :eof )
echo Starting containers (waits for the database health check)...
docker compose up -d --wait db > "%TMPOUT%" 2>&1
if errorlevel 1 ( echo Database did not become healthy: & type "%TMPOUT%" & del "%TMPOUT%" >nul 2>&1 & pause & goto :eof )
echo Applying database migrations...
docker compose run --rm web node apps/web/cli/migrate.ts > "%TMPOUT%" 2>&1
if errorlevel 1 ( echo Database migration failed: & type "%TMPOUT%" & del "%TMPOUT%" >nul 2>&1 & pause & goto :eof )
del "%TMPOUT%" >nul 2>&1
rem Setup state: SETUPSTATE is needed, done or unknown. The token exists only in SETUPTOK and, for the one compose command below, in the environment.
set "SETUPSTATE=unknown"
set "SETUPTOK="
set "BSCOUNT="
for /f "usebackq delims=" %%n in (`docker compose exec -T db psql -U tallymed -d tallymed -tAc "select count(*) from bootstrap_state" 2^>nul`) do set "BSCOUNT=%%n"
if defined BSCOUNT set "SETUPSTATE=done"
if "%BSCOUNT%"=="0" set "SETUPSTATE=needed"
if not "%SETUPSTATE%"=="needed" goto :startweb
set "TOKDEFINED="
if defined TALLYMED_SETUP_TOKEN set "TOKDEFINED=1"
if exist .env findstr /b /r /c:"TALLYMED_SETUP_TOKEN=[^ ]" .env >nul 2>&1 && set "TOKDEFINED=1"
if defined TOKDEFINED goto :startweb
for /f "delims=" %%t in ('powershell -NoProfile -Command "$b=New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b).TrimEnd([char]61).Replace([char]43,[char]45).Replace([char]47,[char]95)"') do set "SETUPTOK=%%t"
:startweb
if defined SETUPTOK set "TALLYMED_SETUP_TOKEN=%SETUPTOK%"
docker compose up -d --wait > "%TMPOUT%" 2>&1
set "UPRESULT=%ERRORLEVEL%"
if defined SETUPTOK set "TALLYMED_SETUP_TOKEN="
if not "%UPRESULT%"=="0" ( set "SETUPTOK=" & echo Containers did not start cleanly: & type "%TMPOUT%" & del "%TMPOUT%" >nul 2>&1 & pause & goto :eof )
del "%TMPOUT%" >nul 2>&1
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
if "%SETUPSTATE%"=="needed" goto :showsetup
if "%SETUPSTATE%"=="done" ( echo An administrator already exists. Sign in at http://127.0.0.1:%PORT%/login ^(no setup token is needed or shown^). & goto :eof )
echo Could not tell whether setup is still needed. If the sign-in page says Setup required, choose Logs ^(3^): the server prints its setup token there.
goto :eof
:showsetup
echo.
echo First-time setup: no administrator exists yet. Open http://127.0.0.1:%PORT%/setup and enter the setup token.
if not defined SETUPTOK goto :tokenfromenv
echo   Setup token ^(shown once, not saved anywhere^): %SETUPTOK%
echo   Choose Start again for a new token while setup is still needed.
set "SETUPTOK="
goto :eof
:tokenfromenv
echo   The token is the TALLYMED_SETUP_TOKEN value you defined in .env or your environment.
goto :eof
