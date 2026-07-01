@echo off
title FinTrack Bot Telegram
echo.
echo  =============================================
echo    FinTrack - Bot Telegram
echo  =============================================
echo.

if not exist "venv" (
    echo [ERRO] Corre primeiro o start.bat para instalar dependencias.
    pause
    exit /b 1
)

call venv\Scripts\activate.bat

if not exist ".env" (
    echo [ERRO] Ficheiro .env nao encontrado.
    echo Copia .env.example para .env e preenche o TELEGRAM_TOKEN.
    pause
    exit /b 1
)

echo  Bot a iniciar...
echo  Certifica-te que o servidor Flask esta a correr (start.bat)
echo.

python bot.py

pause
