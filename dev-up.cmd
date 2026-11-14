@echo off
rem TallyMed local launcher for Windows (development only, fabricated data only).
rem Services from compose.yaml: db (PostgreSQL, pg_isready health check) and web (/healthz). The optional mcp profile is not started.
rem First-run setup: while no administrator exists, the launcher generates a one-time setup token, hands it to the web container for this
rem start only and prints it on screen once. It is never written to .env, a log or a temporary file. If you define TALLYMED_SETUP_TOKEN
rem yourself (.env or environment) that value is used and not displayed.
rem Colors use ANSI codes only when the console shows them (Windows Terminal, or VirtualTerminalLevel set to 1) and NO_COLOR is not set.
rem Otherwise the text is plain. Output redirected to a file is not detected, so pipe with NO_COLOR=1 set to keep it plain.
setlocal EnableExtensions
cd /d "%~dp0"
title TallyMed dev-up

rem ---- Colors -------------------------------------------------------------------------------------------------------------------
set "ESC="
for /F "tokens=1,2 delims=#" %%a in ('"prompt #$H#$E# & echo on & for %%b in (1) do rem"') do set "ESC=%%b"
set "USECOLOR="
if not defined ESC goto :colorsdone
if defined NO_COLOR goto :colorsdone
if defined WT_SESSION set "USECOLOR=1"
if defined USECOLOR goto :colorsdone
for /f "tokens=3" %%v in ('reg query HKCU\Console /v VirtualTerminalLevel 2^>nul') do if "%%v"=="0x1" set "USECOLOR=1"
:colorsdone
set "C_OK="
set "C_WARN="
set "C_ERR="
set "C_HEAD="
set "C_STEP="
set "C_DIM="
set "C_OFF="
if defined USECOLOR set "C_OK=%ESC%[32m"
if defined USECOLOR set "C_WARN=%ESC%[33m"
if defined USECOLOR set "C_ERR=%ESC%[31m"
if defined USECOLOR set "C_HEAD=%ESC%[1;36m"
if defined USECOLOR set "C_STEP=%ESC%[36m"
if defined USECOLOR set "C_DIM=%ESC%[2m"
if defined USECOLOR set "C_OFF=%ESC%[0m"

where docker >nul 2>&1
if errorlevel 1 ( echo %C_ERR%Docker is not installed or not on PATH.%C_OFF% & goto :fatal )
docker compose version >nul 2>&1
if errorlevel 1 ( echo %C_ERR%Docker Compose v2 is required.%C_OFF% & goto :fatal )
docker info >nul 2>&1
if errorlevel 1 ( echo %C_ERR%The Docker daemon is not running. Start Docker Desktop and try again.%C_OFF% & goto :fatal )

:menu
echo.
echo %C_HEAD%TallyMed dev-up%C_OFF%
echo   %C_STEP%1)%C_OFF% Start
echo   %C_STEP%2)%C_OFF% Stop (keep data)
echo   %C_STEP%3)%C_OFF% Logs
echo   %C_STEP%4)%C_OFF% Restart and update
echo   %C_STEP%5)%C_OFF% Wipe (delete data)
echo   %C_STEP%6)%C_OFF% Quit
set "CHOICE="
set /p "CHOICE=Choose (then press Enter): "
if "%CHOICE%"=="6" goto :quit
if /i "%CHOICE%"=="q" goto :quit
if "%CHOICE%"=="5" ( call :wipe & goto :menu )
if "%CHOICE%"=="4" ( call :update & goto :menu )
if "%CHOICE%"=="3" ( call :logs & goto :menu )
if "%CHOICE%"=="2" ( call :stop & goto :menu )
if "%CHOICE%"=="1" ( call :start & goto :menu )
echo %C_WARN%Unknown choice. Type a number from 1 to 6 and press Enter.%C_OFF%
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
if errorlevel 1 ( echo %C_ERR%Stop failed.%C_OFF% & pause ) else ( echo %C_OK%Stopped. Data volumes are kept.%C_OFF% )
goto :eof

:logs
echo %C_STEP%Following logs. Press Ctrl+C, then answer N to the "Terminate batch job" question to return to the menu.%C_OFF%
docker compose logs -f --tail=100
goto :eof

:update
call :gitpull
call :bringup
goto :eof

:wipe
echo %C_WARN%This deletes the local database and the document volume (all local data) for this project.%C_OFF%
set "CONFIRM="
set /p "CONFIRM=Type YES to continue: "
if not "%CONFIRM%"=="YES" ( echo %C_DIM%Cancelled.%C_OFF% & goto :eof )
docker compose --profile mcp down -v --remove-orphans
if errorlevel 1 ( echo %C_ERR%Wipe failed.%C_OFF% & pause ) else ( echo %C_OK%Wiped. Your .env file was not touched.%C_OFF% )
goto :eof

:gitpull
set "TMPOUT=%TEMP%\tallymed-devup-%RANDOM%.txt"
set "BRANCH="
set "UPSTREAM="
set "DIRTY="
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 ( echo %C_WARN%Git: skipped, not a git checkout.%C_OFF% & goto :eof )
for /f "delims=" %%b in ('git symbolic-ref -q --short HEAD 2^>nul') do set "BRANCH=%%b"
if not defined BRANCH ( echo %C_WARN%Git: skipped, HEAD is detached.%C_OFF% & goto :eof )
for /f "delims=" %%u in ('git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2^>nul') do set "UPSTREAM=%%u"
if not defined UPSTREAM ( echo %C_WARN%Git: skipped, branch %BRANCH% has no upstream.%C_OFF% & goto :eof )
for /f "delims=" %%d in ('git status --porcelain --untracked-files=no') do set "DIRTY=1"
if defined DIRTY ( echo %C_WARN%Git: skipped, tracked files have local changes.%C_OFF% & goto :eof )
for /f "delims=" %%h in ('git rev-parse HEAD') do set "OLDHEAD=%%h"
echo %C_STEP%Pulling %BRANCH% from %UPSTREAM%...%C_OFF%
rem The full git output stays hidden unless the pull fails.
git pull --ff-only --quiet > "%TMPOUT%" 2>&1
if errorlevel 1 (
  type "%TMPOUT%"
  echo %C_WARN%Git: pull failed on %BRANCH% ^(offline?^); continuing with the current checkout.%C_OFF%
  del "%TMPOUT%" >nul 2>&1
  goto :eof
)
del "%TMPOUT%" >nul 2>&1
for /f "delims=" %%h in ('git rev-parse HEAD') do set "NEWHEAD=%%h"
if "%OLDHEAD%"=="%NEWHEAD%" ( echo %C_OK%Git: already up to date.%C_OFF% & goto :eof )
for /f "delims=" %%c in ('git rev-list --count %OLDHEAD%..%NEWHEAD%') do set "NCOMMITS=%%c"
echo %C_OK%Git: updated %OLDHEAD:~0,7%..%NEWHEAD:~0,7% ^(%NCOMMITS% commits^)%C_OFF%
rem Concise summary of the changed files: the diffstat, first 25 file lines, then the totals line.
set "STATN=0"
set "STATLAST="
for /f "delims=" %%l in ('git diff --stat %OLDHEAD% %NEWHEAD%') do call :statline "%%l"
if %STATN% gtr 26 echo   %C_DIM%... %STATN% diffstat lines in all; showing the first 25.%C_OFF%
if %STATN% gtr 25 echo   %C_DIM%%STATLAST%%C_OFF%
goto :eof

:statline
set /a STATN+=1
set "STATLAST=%~1"
if %STATN% leq 25 echo   %C_DIM%%~1%C_OFF%
goto :eof

:bringup
set "TMPOUT=%TEMP%\tallymed-devup-%RANDOM%.txt"
if exist .env (
  echo %C_OK%Using existing .env ^(left unchanged^).%C_OFF%
) else if exist .env.example (
  copy /-y .env.example .env >nul
  echo %C_OK%Created .env from .env.example ^(local development values^).%C_OFF%
) else (
  echo %C_ERR%.env.example is missing; cannot create .env.%C_OFF% & pause & goto :eof
)
findstr /b /r /c:"TALLYMED_SECRETS_KEY=[^ ]" .env >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "$b=New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); $k=[Convert]::ToBase64String($b); $f=@(Get-Content .env | Where-Object { $_ -notmatch '^TALLYMED_SECRETS_KEY=' }); $f + ('TALLYMED_SECRETS_KEY=' + $k) | Set-Content -Encoding ascii .env"
  echo %C_OK%Generated a local TALLYMED_SECRETS_KEY in .env.%C_OFF%
)
echo %C_STEP%Building images ^(the build log is shown only if it fails^)...%C_OFF%
docker compose build --quiet > "%TMPOUT%" 2>&1
if errorlevel 1 ( echo %C_ERR%Image build failed:%C_OFF% & type "%TMPOUT%" & del "%TMPOUT%" >nul 2>&1 & pause & goto :eof )
echo %C_STEP%Starting containers (waits for the database health check)...%C_OFF%
docker compose up -d --wait db > "%TMPOUT%" 2>&1
if errorlevel 1 ( echo %C_ERR%Database did not become healthy:%C_OFF% & type "%TMPOUT%" & del "%TMPOUT%" >nul 2>&1 & pause & goto :eof )
echo %C_STEP%Applying database migrations...%C_OFF%
docker compose run --rm web node apps/web/cli/migrate.ts > "%TMPOUT%" 2>&1
if errorlevel 1 ( echo %C_ERR%Database migration failed:%C_OFF% & type "%TMPOUT%" & del "%TMPOUT%" >nul 2>&1 & pause & goto :eof )
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
if not "%UPRESULT%"=="0" ( set "SETUPTOK=" & echo %C_ERR%Containers did not start cleanly:%C_OFF% & type "%TMPOUT%" & del "%TMPOUT%" >nul 2>&1 & pause & goto :eof )
del "%TMPOUT%" >nul 2>&1
set "PORT=3001"
if exist .env for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b /c:"TALLYMED_WEB_PORT=" .env`) do set "PORT=%%b"
set "PORT=%PORT:"=%"
where curl.exe >nul 2>&1
if errorlevel 1 ( echo %C_WARN%curl.exe not found; skipping the web health check.%C_OFF% & goto :urls )
set /a TRIES=0
<nul set /p "=%C_DIM%Waiting for the web app to answer /healthz%C_OFF%"
:waitloop
curl.exe -fsS -o nul "http://127.0.0.1:%PORT%/healthz" >nul 2>&1
if not errorlevel 1 ( echo  %C_OK%ok%C_OFF% & goto :urls )
set /a TRIES+=1
if %TRIES% geq 60 ( echo. & echo %C_ERR%The web app did not become healthy. Choose Logs to see why.%C_OFF% & pause & goto :eof )
<nul set /p "=%C_DIM%.%C_OFF%"
ping -n 3 127.0.0.1 >nul
goto :waitloop
:urls
echo.
echo %C_HEAD%TallyMed is running (fabricated local data only):%C_OFF%
echo   App:    %C_STEP%http://127.0.0.1:%PORT%%C_OFF%
echo   Health: %C_STEP%http://127.0.0.1:%PORT%/healthz%C_OFF%
if "%SETUPSTATE%"=="needed" goto :showsetup
if "%SETUPSTATE%"=="done" ( echo %C_OK%An administrator already exists. Sign in at http://127.0.0.1:%PORT%/login ^(no setup token is needed or shown^).%C_OFF% & goto :eof )
echo %C_WARN%Could not tell whether setup is still needed. If the sign-in page says Setup required, choose Logs ^(3^): the server prints its setup token there.%C_OFF%
goto :eof
:showsetup
echo.
echo %C_WARN%First-time setup: no administrator exists yet. Open http://127.0.0.1:%PORT%/setup and enter the setup token.%C_OFF%
if not defined SETUPTOK goto :tokenfromenv
echo   Setup token ^(shown once, not saved anywhere^): %C_WARN%%SETUPTOK%%C_OFF%
echo   %C_DIM%Choose Start again for a new token while setup is still needed.%C_OFF%
set "SETUPTOK="
goto :eof
:tokenfromenv
echo   %C_DIM%The token is the TALLYMED_SETUP_TOKEN value you defined in .env or your environment.%C_OFF%
goto :eof
