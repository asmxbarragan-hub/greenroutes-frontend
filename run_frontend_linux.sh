#!/usr/bin/env bash
# =============================================================
#  GreenRoutes - Lanzador FRONTEND (Linux/Mac)
#  - Sirve la carpeta actual en http://127.0.0.1:5500
#  - Intenta abrir el navegador automáticamente
# =============================================================

set -euo pipefail
cd "$(dirname "$0")"

echo "[INFO] Carpeta frontend: $(pwd)"
echo "[INFO] Recuerda configurar ORS_API_KEY en app.js"

URL="http://127.0.0.1:5500"

# Abrir navegador (según sistema)
( command -v xdg-open >/dev/null 2>&1 && xdg-open "$URL" ) \
 || ( command -v open >/dev/null 2>&1 && open "$URL" ) \
 || true

echo "[INFO] Sirviendo frontend en ${URL}  (CTRL+C para parar)"
python3 -m http.server 5500