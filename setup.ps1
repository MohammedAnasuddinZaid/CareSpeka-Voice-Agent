[CmdletBinding()]
param([switch]$RefreshLocalCertificate)

$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
$Backend = Join-Path $ProjectRoot 'backend'
$Models = Join-Path $Backend 'models'
$Runtime = Join-Path $Backend 'runtime'
$Downloads = Join-Path $Runtime 'downloads'
New-Item -ItemType Directory -Force -Path $Models, $Runtime, $Downloads | Out-Null

function Get-OpenSsl {
    $command = Get-Command openssl -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidates = @(
        'C:\Program Files\Git\usr\bin\openssl.exe',
        'C:\msys64\ucrt64\bin\openssl.exe'
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return $candidate }
    }
    throw 'OpenSSL is required to create the local phone certificate. Install Git for Windows or OpenSSL, then rerun setup.ps1.'
}

function Invoke-OpenSsl([string]$Executable, [string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Executable @Arguments 2>$null | Out-Null
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Get-LanAddresses {
    $addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.AddressState -eq 'Preferred' -and
            ($_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)')
        } |
        Select-Object -ExpandProperty IPAddress -Unique
    return @($addresses)
}

function Invoke-Download([string]$Url, [string]$Destination) {
    if (Test-Path $Destination) { return }
    Write-Host "Downloading $([IO.Path]::GetFileName($Destination))..."
    Invoke-WebRequest -Uri $Url -OutFile $Destination
}

$pythonLauncher = Get-Command py -ErrorAction SilentlyContinue
if ($pythonLauncher) {
    & py -3.10 --version 2>$null
    if ($LASTEXITCODE -eq 0) { $Python = 'py'; $PythonArgs = @('-3.10') }
}
if (-not $Python) {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pythonCommand) { throw 'Python 3.10 is required. Install it from python.org, then rerun setup.ps1.' }
    $pythonVersion = & python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'
    if ($pythonVersion -ne '3.10') { throw "Python 3.10 is required by the pinned local runtime; found $pythonVersion." }
    $Python = 'python'
    $PythonArgs = @()
}

$venvPython = Join-Path $Backend '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPython)) {
    & $Python @PythonArgs -m venv (Join-Path $Backend '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Could not create backend virtual environment.' }
}
& $venvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw 'Could not upgrade pip.' }
& $venvPython -m pip install -r (Join-Path $Backend 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Could not install backend requirements.' }

Push-Location $ProjectRoot
try {
    if (Test-Path (Join-Path $ProjectRoot 'node_modules')) {
        npm install --no-audit --no-fund
    } else {
        npm ci
    }
    if ($LASTEXITCODE -ne 0) { throw 'Could not install frontend dependencies.' }
} finally {
    Pop-Location
}

$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollama) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) { throw 'Install the free Ollama desktop runtime from https://ollama.com/download, then rerun setup.ps1.' }
    winget install --id Ollama.Ollama --exact --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw 'Ollama installation failed. Install it from https://ollama.com/download and rerun setup.ps1.' }
    throw 'Ollama was installed. Open a new PowerShell window so PATH refreshes, then rerun setup.ps1.'
}

$tagUrl = 'http://127.0.0.1:11434/api/tags'
try { Invoke-RestMethod -Uri $tagUrl -TimeoutSec 2 | Out-Null }
catch {
    Start-Process -FilePath $ollama.Source -ArgumentList 'serve' -WindowStyle Hidden | Out-Null
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Seconds 1
        try { Invoke-RestMethod -Uri $tagUrl -TimeoutSec 2 | Out-Null; $ready = $true; break } catch {}
    }
    if (-not $ready) { throw 'Ollama did not start. Start Ollama from the Start menu and rerun setup.ps1.' }
}
$installedModels = (Invoke-RestMethod -Uri $tagUrl).models.name
if ($installedModels -notcontains 'qwen2.5:3b') {
    Write-Host 'Downloading the free local Qwen2.5 3B model (one-time setup)...'
    & $ollama.Source pull qwen2.5:3b
    if ($LASTEXITCODE -ne 0) { throw 'Could not download qwen2.5:3b.' }
}

$whisperDirectory = Join-Path $Models 'whisper'
New-Item -ItemType Directory -Force -Path $whisperDirectory | Out-Null
Invoke-Download 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin' (Join-Path $whisperDirectory 'ggml-base.en.bin')

$vadDirectory = Join-Path $Models 'vad'
New-Item -ItemType Directory -Force -Path $vadDirectory | Out-Null
Invoke-Download 'https://github.com/snakers4/silero-vad/raw/refs/heads/master/src/silero_vad/data/silero_vad.onnx' (Join-Path $vadDirectory 'silero_vad.onnx')

$whisperRelease = 'b5454'
$whisperBinary = Join-Path $Models 'whisper.cpp\cpu\Release\whisper-server.exe'
if (-not (Test-Path $whisperBinary)) {
    $archive = Join-Path $Downloads 'whisper-bin-x64.zip'
    Invoke-Download "https://github.com/ggml-org/whisper.cpp/releases/download/$whisperRelease/whisper-bin-x64.zip" $archive
    $extract = Join-Path $Downloads 'whisper-bin-x64'
    if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
    Expand-Archive -Path $archive -DestinationPath $extract -Force
    $server = Get-ChildItem $extract -Recurse -Filter 'whisper-server.exe' | Select-Object -First 1
    if (-not $server) { throw "whisper-server.exe was not found in $archive." }
    $destination = Split-Path $whisperBinary -Parent
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Copy-Item (Join-Path $server.DirectoryName '*') $destination -Recurse -Force
}

$ttsDirectory = Join-Path $Models 'tts'
New-Item -ItemType Directory -Force -Path $ttsDirectory | Out-Null
$ttsModelDirectory = Join-Path $ttsDirectory 'sherpa-ljs'
if (-not (Test-Path (Join-Path $ttsModelDirectory 'vits-ljs.onnx'))) {
    $archive = Join-Path $Downloads 'vits-ljs.tar.bz2'
    Invoke-Download 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-ljs.tar.bz2' $archive
    $extract = Join-Path $Downloads 'vits-ljs'
    New-Item -ItemType Directory -Force -Path $extract | Out-Null
    & tar -xjf $archive -C $extract
    if ($LASTEXITCODE -ne 0) { throw 'Could not extract the sherpa-onnx VITS model archive.' }
    $model = Get-ChildItem $extract -Recurse -Filter 'vits-ljs.onnx' | Select-Object -First 1
    if (-not $model) { throw 'vits-ljs.onnx was not present in the downloaded archive.' }
    Copy-Item $model.DirectoryName $ttsModelDirectory -Recurse -Force
}

$localAddresses = @(Get-LanAddresses)
if ($localAddresses.Count -eq 0) { throw 'No private IPv4 address was found. Connect the PC to Wi-Fi/Ethernet, then rerun setup.ps1.' }
$caKey = Join-Path $Runtime 'ca.key'
$caCert = Join-Path $Runtime 'ca.crt'
$serverKey = Join-Path $Runtime 'server.key'
$serverCsr = Join-Path $Runtime 'server.csr'
$serverCert = Join-Path $Runtime 'server.crt'
$extensions = Join-Path $Runtime 'server.ext'
$certificateIps = Join-Path $Runtime 'certificate-ips.txt'
$currentIps = (($localAddresses | Sort-Object) -join ',')
$storedIps = if (Test-Path $certificateIps) { (Get-Content $certificateIps -Raw).Trim() } else { '' }
$certificateMissing = -not (Test-Path $caCert) -or -not (Test-Path $caKey) -or -not (Test-Path $serverCert) -or -not (Test-Path $serverKey)
if ($RefreshLocalCertificate -or $certificateMissing -or $storedIps -ne $currentIps) {
    $openssl = Get-OpenSsl
    if ($RefreshLocalCertificate -or -not (Test-Path $caCert) -or -not (Test-Path $caKey)) {
        if ((Invoke-OpenSsl $openssl @('req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '3650', '-keyout', $caKey, '-out', $caCert, '-subj', '/CN=CareSpeak Local CA')) -ne 0) {
            throw 'Could not create the local certificate authority.'
        }
    }
    if ((Invoke-OpenSsl $openssl @('genrsa', '-out', $serverKey, '2048')) -ne 0) {
        throw 'Could not create the local HTTPS key.'
    }
    if ((Invoke-OpenSsl $openssl @('req', '-new', '-key', $serverKey, '-out', $serverCsr, '-subj', '/CN=CareSpeak Local Phone Gateway')) -ne 0) {
        throw 'Could not create the local HTTPS request.'
    }
    $extensionLines = @('basicConstraints=CA:FALSE', 'keyUsage=digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth', 'subjectAltName=@alt_names', '[alt_names]', 'DNS.1=localhost', 'IP.1=127.0.0.1')
    $sanIndex = 2
    foreach ($address in $localAddresses) { $extensionLines += "IP.$sanIndex=$address"; $sanIndex++ }
    Set-Content -Path $extensions -Value $extensionLines -Encoding ascii
    if ((Invoke-OpenSsl $openssl @('x509', '-req', '-in', $serverCsr, '-CA', $caCert, '-CAkey', $caKey, '-CAcreateserial', '-out', $serverCert, '-days', '825', '-sha256', '-extfile', $extensions)) -ne 0) {
        throw 'Could not sign the local HTTPS certificate.'
    }
    Set-Content -Path $certificateIps -Value $currentIps -Encoding ascii
    Write-Host "Local phone certificate updated for $currentIps."
}

Write-Host ''
Write-Host 'Setup complete. Downloaded models and local certificates stay on this PC.'
Write-Host "Phone address: https://$($localAddresses[0]):3443/voicelink"
Write-Host "Phone certificate: http://$($localAddresses[0]):3080/ca.crt"
Write-Host 'Next: run .\start.ps1. The phone and PC must share a private Wi-Fi network.'
