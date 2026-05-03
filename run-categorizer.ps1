# run-categorizer.ps1
# Actual Budget Auto-Categorizer - Home Environment Launcher
# Use ASCII-only symbols: Windows PowerShell 5.1 misparses UTF-8 checkmarks in some encodings.

param(
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

Write-Host "Actual Budget Auto-Categorizer" -ForegroundColor Cyan
Write-Host "===================================" -ForegroundColor Cyan

# --- Config ---
$OllamaPath = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"
# Root URL often returns 404; use API endpoint for health checks.
$OllamaTagsUrl = "http://127.0.0.1:11434/api/tags"
$OllamaPsUrl   = "http://127.0.0.1:11434/api/ps"
$Model      = "llama3"
$ProjectDir = $PSScriptRoot
$UseVulkan  = $true

function Test-OllamaListening {
    try {
        $tcp = Test-NetConnection -ComputerName 127.0.0.1 -Port 11434 -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
        return $tcp.TcpTestSucceeded
    } catch {
        return $false
    }
}

function Test-OllamaApi {
    try {
        $null = Invoke-RestMethod -Uri $OllamaTagsUrl -Method Get -TimeoutSec 3 -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Test-OllamaVulkanLikely {
    try {
        $res = Invoke-WebRequest -Uri $OllamaPsUrl -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        if ($res.Content -match '(?i)vulkan') {
            return $true
        }
    } catch {
        # ignore
    }

    try {
        $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^(ollama\.exe|cmd\.exe)$' -and $_.CommandLine }
        foreach ($p in $procs) {
            if ($p.CommandLine -match '(?i)OLLAMA_VULKAN\s*=\s*1') {
                return $true
            }
        }
    } catch {
        # ignore
    }

    return $false
}

# --- Step 1: Check Ollama is installed ---
Write-Host "`n[1/4] Checking Ollama installation..." -ForegroundColor Yellow
if (-not (Test-Path $OllamaPath)) {
    Write-Host "[X] Ollama not found at $OllamaPath" -ForegroundColor Red
    Write-Host "  Download from: https://ollama.com/download" -ForegroundColor Gray
    exit 1
}
Write-Host "[OK] Ollama found" -ForegroundColor Green

if ($UseVulkan) {
    if ([string]::IsNullOrWhiteSpace($env:OLLAMA_VULKAN)) {
        Write-Host "  [i] OLLAMA_VULKAN is not set in this PowerShell session; serve will use Vulkan via cmd (OLLAMA_VULKAN=1)." -ForegroundColor DarkGray
    }
}

# --- Step 2: Start Ollama if not already running ---
Write-Host "`n[2/4] Checking Ollama server..." -ForegroundColor Yellow

if (Test-OllamaApi) {
    if ($UseVulkan -and -not (Test-OllamaVulkanLikely)) {
        Write-Host "[!] Ollama is running but Vulkan mode was not detected ($OllamaPsUrl / process command line). Restarting with OLLAMA_VULKAN=1..." -ForegroundColor Yellow
        Get-Process -Name ollama -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Seconds 2
        $spin = 0
        while ((Test-OllamaApi) -and $spin -lt 30) {
            Start-Sleep -Milliseconds 500
            $spin++
        }
        if ((Test-OllamaApi) -and -not (Test-OllamaVulkanLikely)) {
            Write-Host "[X] Ollama is still up without Vulkan; stop it manually or close the tray app, then re-run." -ForegroundColor Red
            exit 1
        }
    }

    if (Test-OllamaApi) {
        if ($UseVulkan) {
            Write-Host "✓ Ollama server is running (Vulkan mode)" -ForegroundColor Green
        } else {
            Write-Host "[OK] Ollama API already responding ($OllamaTagsUrl)" -ForegroundColor Green
        }
    }
}

if (-not (Test-OllamaApi)) {
    Write-Host "  Ollama API not reachable yet; starting server..." -ForegroundColor Gray
    if ($UseVulkan) {
        Start-Process -FilePath "cmd.exe" -ArgumentList "/c set OLLAMA_VULKAN=1 && `"$OllamaPath`" serve" -WindowStyle Hidden
    } else {
        Start-Process -FilePath $OllamaPath -ArgumentList "serve" -WindowStyle Hidden
    }

    $maxWaitSec = 90
    $elapsed = 0
    Write-Host "  Waiting up to ${maxWaitSec}s for Ollama (first start can be slow)..." -ForegroundColor Gray

    while ($elapsed -lt $maxWaitSec) {
        Start-Sleep -Seconds 2
        $elapsed += 2
        if (Test-OllamaApi) {
            if ($UseVulkan) {
                Write-Host "✓ Ollama server is ready (${elapsed}s) (Vulkan mode)" -ForegroundColor Green
            } else {
                Write-Host "[OK] Ollama server is ready (${elapsed}s)" -ForegroundColor Green
            }
            break
        }
        if (($elapsed % 10) -eq 0) {
            $listening = Test-OllamaListening
            Write-Host "  ... still waiting (${elapsed}s)  [port 11434 open: $listening]" -ForegroundColor DarkGray
        }
    }

    if (-not (Test-OllamaApi)) {
        Write-Host "[X] Ollama did not become ready after ${maxWaitSec}s" -ForegroundColor Red
        Write-Host "  Try manually in another window:  ollama serve" -ForegroundColor Yellow
        Write-Host "  Or launch the Ollama app from the Start menu (system tray), then re-run this script." -ForegroundColor Yellow
        Write-Host "  Health check URL: $OllamaTagsUrl" -ForegroundColor Gray
        exit 1
    }
}

# --- Step 3: Check llama3 model is available ---
Write-Host "`n[3/4] Checking llama3 model..." -ForegroundColor Yellow
$modelsJson = & $OllamaPath list 2>&1
if ($modelsJson -notmatch "llama3") {
    Write-Host "  llama3 not found - pulling now (this may take a few minutes)..." -ForegroundColor Gray
    & $OllamaPath pull $Model
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[X] Failed to pull llama3" -ForegroundColor Red
        exit 1
    }
}
Write-Host "[OK] llama3 model ready" -ForegroundColor Green

# --- Step 4: Run the categorizer ---
Write-Host "`n[4/4] Running categorizer..." -ForegroundColor Yellow

Set-Location $ProjectDir

if ($DryRun) {
    Write-Host "  Mode: DRY RUN (no changes will be saved)`n" -ForegroundColor Magenta
    $env:DRY_RUN = "true"
} else {
    Write-Host "  Mode: LIVE (categories will be applied)`n" -ForegroundColor White
    $env:DRY_RUN = "false"
}

node src/index.js

if ($LASTEXITCODE -ne 0) {
    Write-Host "`n[X] Categorizer exited with an error" -ForegroundColor Red
    exit 1
}

Write-Host "`n[OK] Done!" -ForegroundColor Green
