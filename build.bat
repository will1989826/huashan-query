@echo off
chcp 65001 >nul
cd /d "%~dp0"
set /p VER=<VERSION
echo ============================================
echo   Huashan Query - Build v%VER%
echo ============================================
echo Compiling single-file Go exe...
if not exist bin mkdir bin
go build -ldflags "-s -w -H windowsgui -X main.version=v%VER%" -o "bin\华山战力查询-v%VER%.exe" . || goto :err
echo.
echo ============================================
echo   Done!  bin\华山战力查询-v%VER%.exe
echo   Ship this single exe to users as-is.
echo ============================================
pause
exit /b 0
:err
echo.
echo *** Build failed - please send the error above to the author ***
pause
exit /b 1
