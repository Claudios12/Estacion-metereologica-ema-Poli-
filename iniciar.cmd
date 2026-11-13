@echo off
rem Lanzador de Poli Clima para Windows: doble clic para abrirlo.
rem Busca un Node.js compatible (22.13+), arranca el servidor, abre el navegador y,
rem si algo falla, deja la ventana abierta con el mensaje en lugar de cerrarla.
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Poli Clima

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js no esta instalado. Instale Node.js 24 LTS desde https://nodejs.org y vuelva a abrir este archivo.
  echo.
  pause
  exit /b 1
)

node scripts\iniciar.mjs %*
set CODIGO=%ERRORLEVEL%

echo.
if "%CODIGO%"=="0" (
  echo   Poli Clima se detuvo.
) else (
  echo   Poli Clima se detuvo con un error. Lea el mensaje de arriba.
)
echo.
pause
exit /b %CODIGO%
