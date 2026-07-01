@echo off
title FinTrack — Telegram Bridge
color 0A
echo.
echo  ================================================
echo    FinTrack — Bot Telegram
echo  ================================================
echo.

if not exist "telegram-bridge\config.json" (
    echo  [AVISO] config.json nao encontrado.
    echo  Copia telegram-bridge\config.json.example para
    echo  telegram-bridge\config.json e coloca o teu token.
    echo.
    pause
    exit /b 1
)

echo  A iniciar servidor na porta 3100...
echo  Deixa esta janela aberta enquanto usas o FinTrack.
echo.
node telegram-bridge\server.js
pause
