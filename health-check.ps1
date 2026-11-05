$ErrorActionPreference = 'Stop'
$BackendHealth = 'http://127.0.0.1:8000/api/voicelink/health?refresh=true'
$FrontendUrl = 'http://127.0.0.1:3000/voicelink'
$GatewayPort = 3443

try {
    $health = Invoke-RestMethod -Uri $BackendHealth -TimeoutSec 10
    Write-Host "Backend: $($health.status)"
    foreach ($check in $health.checks.PSObject.Properties) {
        $label = if ($check.Value) { 'READY' } else { 'MISSING' }
        Write-Host ("  {0,-18} {1}" -f $check.Name, $label)
    }
    Write-Host "Local only: $($health.local_only)"
    Write-Host "Phone address: $($health.gateway.phone_url)"
} catch {
    Write-Host "Backend: OFFLINE ($($_.Exception.Message))" -ForegroundColor Red
    exit 1
}

try {
    $page = Invoke-WebRequest -Uri $FrontendUrl -TimeoutSec 10 -UseBasicParsing
    Write-Host "Frontend: HTTP $($page.StatusCode)"
} catch {
    Write-Host "Frontend: OFFLINE ($($_.Exception.Message))" -ForegroundColor Red
    exit 1
}

$gateway = Get-NetTCPConnection -State Listen -LocalPort $GatewayPort -ErrorAction SilentlyContinue | Select-Object -First 1
if ($gateway) {
    Write-Host "Phone gateway: LISTENING on $($gateway.LocalAddress):$GatewayPort"
} else {
    Write-Host "Phone gateway: OFFLINE on port $GatewayPort" -ForegroundColor Red
    exit 1
}

if ($health.status -ne 'ready') {
    Write-Host 'One or more local engines are not ready. See backend/logs and backend/runtime.' -ForegroundColor Yellow
    exit 1
}
Write-Host 'All required local services are ready.' -ForegroundColor Green
