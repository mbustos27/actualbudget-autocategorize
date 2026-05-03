# Fixes "out-of-sync-migrations": installs matching @actual-app/api and clears local budget cache.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "Removing package-lock.json (forces npm to resolve @actual-app/api again)..." -ForegroundColor Yellow
Remove-Item -Force .\package-lock.json -ErrorAction SilentlyContinue

Write-Host "Removing local budget cache (actual-data)..." -ForegroundColor Yellow
Remove-Item -Recurse -Force .\actual-data -ErrorAction SilentlyContinue

Write-Host "npm install..." -ForegroundColor Yellow
npm install

Write-Host "`nInstalled Actual API package:" -ForegroundColor Cyan
npm ls @actual-app/api --depth=0

Write-Host "`nDone. Next: .\run-categorizer.ps1 -DryRun" -ForegroundColor Green
