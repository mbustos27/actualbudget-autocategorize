# Runs setup-next-month only on the 1st calendar day (for Task Scheduler).
$ProjectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $ProjectRoot
if ((Get-Date).Day -ne 1) {
  exit 0
}
& node "scripts\setup-next-month.mjs" @args
