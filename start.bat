@echo off
title FinTrack
echo.
echo  =============================================
echo    FinTrack - Sistema de Gestao Financeiro
echo  =============================================
echo.

:: Verificar Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERRO] Python nao encontrado. Instala em python.org
    pause
    exit /b 1
)

:: Instalar dependencias se necessario
if not exist "venv" (
    echo A criar ambiente virtual...
    python -m venv venv
)

call venv\Scripts\activate.bat

pip show flask >nul 2>&1
if errorlevel 1 (
    echo A instalar dependencias...
    pip install -r requirements.txt -q
)

:: Criar .env se nao existir
if not exist ".env" (
    copy .env.example .env >nul
    echo [AVISO] Ficheiro .env criado. Edita com o teu token Telegram.
)

echo.
echo  Servidor a iniciar em http://localhost:5000
echo  Abre o browser em: http://localhost:5000
echo.
echo  Para o Bot Telegram: abre outro terminal e corre start_bot.bat
echo.

start "" "http://localhost:5000"
python app.py

pause
