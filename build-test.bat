@echo off
chcp 65001 >nul
cd /d "%~dp0"
set /p VER=<VERSION
echo ============================================
echo   Huashan Query - Test Build v%VER%
echo ============================================
echo Compiling limited test version...
if not exist bin mkdir bin
set "UPD="
if exist deploy-url.txt set /p UPD=<deploy-url.txt
go build -ldflags "-s -w -H windowsgui -X main.version=v%VER%-test -X main.buildMode=test -X main.updateURL=%UPD%" -o "bin\华山战力查询-测试版-v%VER%.exe" . || goto :err
echo.
echo ============================================
echo   Done!  bin\华山战力查询-测试版-v%VER%.exe
echo   Limit: 20 player queries or 20 minutes.
echo ============================================
pause
exit /b 0
:err
echo.
echo *** Build failed - please send the error above to the author ***
pause
exit /b 1
