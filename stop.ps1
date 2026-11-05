$ProjectRoot = $PSScriptRoot
$Runtime = Join-Path $ProjectRoot 'backend\runtime'
$stopped = New-Object 'System.Collections.Generic.HashSet[int]'

function Stop-Tree([int]$ProcessId, [string]$Label) {
    if ($stopped.Contains($ProcessId)) { return }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if (-not $process) { return }
    & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
    $null = $stopped.Add($ProcessId)
    Write-Host "Stopped $Label (PID $ProcessId)."
}

foreach ($name in @('phone-gateway', 'frontend', 'backend', 'whisper', 'ollama')) {
    $pidPath = Join-Path $Runtime "$name.pid"
    if (-not (Test-Path $pidPath)) { continue }
    $processId = 0
    if ([int]::TryParse((Get-Content $pidPath -Raw).Trim(), [ref]$processId)) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
        $ownsProject = $process -and (($process.ExecutablePath -like "$ProjectRoot*") -or ($process.CommandLine -like "*$ProjectRoot*"))
        if ($ownsProject -or ($process -and $name -eq 'ollama')) {
            Stop-Tree $processId $name
        } else {
            Write-Host "Skipped stale or unrelated PID for $name."
        }
    }
    Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
}

# Children such as npm/next may outlive the wrapper process recorded in the pid file.
$sweepNames = @('node.exe', 'python.exe', 'pythonw.exe', 'whisper-server.exe', 'cmd.exe')
foreach ($process in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) {
    if ($sweepNames -notcontains $process.Name.ToLower()) { continue }
    if ($process.CommandLine -and $process.CommandLine -like "*$ProjectRoot*") {
        Stop-Tree $process.ProcessId $process.Name
    }
}

exit 0
