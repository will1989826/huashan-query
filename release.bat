@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   Huashan Query - One-click Release
echo ============================================
echo 构建 exe、推送 GitHub+Gitee、建发行版并上传、更新 latest.json...
go run ./cmd/release || goto :err
echo.
echo ============================================
echo   发布完成！
echo ============================================
pause
exit /b 0
:err
echo.
echo *** 发布失败 - 请把上面的错误发给作者 ***
pause
exit /b 1
