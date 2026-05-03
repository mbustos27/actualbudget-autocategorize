# setup-automation.ps1
$ProjectDir = Split-Path -Parent $PSScriptRoot
$CategorizerScript = Join-Path $ProjectDir "run-categorizer.ps1"
$MonthlyReportScript = Join-Path $ProjectDir "scripts\send-monthly-report.ps1"

Write-Host "Setting up automation..." -ForegroundColor Cyan

# Task 1: Nightly categorizer
$action1 = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NonInteractive -ExecutionPolicy Bypass -File `"$CategorizerScript`""
$trigger1 = New-ScheduledTaskTrigger -Daily -At "11:00PM"
$settings1 = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd

Register-ScheduledTask `
  -TaskName "ActualBudget-Nightly" `
  -Action $action1 `
  -Trigger $trigger1 `
  -Settings $settings1 `
  -Description "Nightly Actual Budget transaction categorizer" `
  -Force

Write-Host "Nightly categorizer registered: every day at 11 PM" -ForegroundColor Green

# Task 2: Monthly email report (last day of month at 8 PM)
$action2 = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NonInteractive -ExecutionPolicy Bypass -File `"$MonthlyReportScript`""
$trigger2 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At "8:00PM"
$settings2 = New-ScheduledTaskSettingsSet -StartWhenAvailable

Register-ScheduledTask `
  -TaskName "ActualBudget-MonthlyReport" `
  -Action $action2 `
  -Trigger $trigger2 `
  -Settings $settings2 `
  -Description "Monthly Actual Budget email report" `
  -Force

Write-Host "Monthly report registered: every Sunday at 8 PM" -ForegroundColor Green
Write-Host "`nDone! Run as Administrator if tasks fail to register." -ForegroundColor Cyan
