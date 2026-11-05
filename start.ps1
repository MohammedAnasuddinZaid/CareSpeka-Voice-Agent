$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
$Backend = Join-Path $ProjectRoot 'backend'
$Runtime = Join-Path $Backend 'runtime'
$Logs = Join-Path $Backend 'logs'
New-Item -ItemType Directory -Force -Path $Runtime, $Logs | Out-Null

function Test-LocalHttp([string]$Url) {
    try { Invoke-WebRequest -Uri $Url -TimeoutSec 10 -UseBasicParsing | Out-Null; return $true }
    catch { return $false }
}

function Start-LocalProcess([string]$Name, [string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory) {
    $pidPath = Join-Path $Runtime "$Name.pid"
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Logs "$Name.out.log") -RedirectStandardError (Join-Path $Logs "$Name.err.log") -PassThru
    Set-Content -Path $pidPath -Value $process.Id -Encoding ascii
    Write-Host "Started $Name (PID $($process.Id))."
}

$ollamaUrl = 'http://127.0.0.1:11434/api/tags'
if (-not (Test-LocalHttp $ollamaUrl)) {
    $ollama = Get-Command ollama -ErrorAction Stop
    Start-LocalProcess 'ollama' $ollama.Source @('serve') $ProjectRoot
}

$healthUrl = 'http://127.0.0.1:8000/api/voicelink/health'
if (-not (Test-LocalHttp $healthUrl)) {
    $python = Join-Path $Backend '.venv\Scripts\python.exe'
    if (-not (Test-Path $python)) { throw 'Backend environment is missing. Run .\setup.ps1 first.' }
    Start-LocalProcess 'backend' $python @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000') $Backend
}

$frontendUrl = 'http://127.0.0.1:3000/voicelink'
if (-not (Test-LocalHttp $frontendUrl)) {
    Start-LocalProcess 'frontend' $env:ComSpec @('/c', 'npm run dev -- --hostname 127.0.0.1 --port 3000') $ProjectRoot
}

$gatewayListening = Get-NetTCPConnection -State Listen -LocalPort 3443 -ErrorAction SilentlyContinue
if (-not $gatewayListening) {
    $key = Join-Path $Runtime 'server.key'
    $cert = Join-Path $Runtime 'server.crt'
    if (-not (Test-Path $key) -or -not (Test-Path $cert)) { throw 'Local phone TLS files are missing. Run .\setup.ps1 first.' }
    Start-LocalProcess 'phone-gateway' (Get-Command node -ErrorAction Stop).Source @(('"' + (Join-Path $Backend 'phone-gateway.mjs') + '"')) $ProjectRoot
}

$lanIp = ''
Push-Location $Backend
try {
    $lanIp = (& (Join-Path $Backend '.venv\Scripts\python.exe') -c 'from app.config import settings; print(settings.lan_ip)' | Select-Object -First 1)
} finally {
    Pop-Location
}
Write-Host ''
Write-Host 'CareSpeak VoiceLink is starting locally.'
Write-Host "Desktop: http://127.0.0.1:3000/voicelink"
Write-Host "Phone:   https://$lanIp`:3443/voicelink"
Write-Host "CA file: http://$lanIp`:3080/ca.crt"
Write-Host 'Phone and PC must share a private Wi-Fi network. Install the local CA on the phone once.'
Write-Host 'Run .\health-check.ps1 after startup; run .\stop.ps1 to stop processes started here.'
