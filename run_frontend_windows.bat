@echo off
REM ============================================================
REM  GreenRoutes - Lanzador FRONTEND (Windows)
REM  - Sirve la carpeta actual en http://127.0.0.1:5500
REM  - Abre el navegador automáticamente
REM ============================================================

setlocal
cd /d "%~dp0"

echo [INFO] Carpeta frontend: %cd%
echo [INFO] Asegurate de configurar tu ORS_API_KEY en app.js

REM Intentar usar Python embebido para servidor simple
for /f "tokens=2 delims==" %%v in ('wmic os get Caption /value ^| find "="') do set OSNAME=%%v
echo [INFO] Sistema: %OSNAME%

start "" "http://127.0.0.1:5500"
echo [INFO] Sirviendo frontend en http://127.0.0.1:5500  (CTRL+C para parar)

python -m http.server 5500