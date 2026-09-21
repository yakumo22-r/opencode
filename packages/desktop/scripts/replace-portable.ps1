param(
  [string] $Source = (Join-Path $PSScriptRoot "..\dist\opencode-desktop-win-x64-prod.exe"),
  [string] $Target = (Join-Path $PSScriptRoot "..\dist\opencode-desktop-win-x64.exe"),
  [int] $DelaySeconds = 5
)

$ErrorActionPreference = "Stop"

$sourcePath = (Resolve-Path $Source).Path
$targetPath = [System.IO.Path]::GetFullPath($Target)

if ($sourcePath -eq $targetPath) {
  throw "Source and target must be different files"
}

if ($DelaySeconds -lt 0) {
  throw "DelaySeconds must be zero or greater"
}

$processes = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $targetPath, [System.StringComparison]::OrdinalIgnoreCase)
})

foreach ($process in $processes) {
  Write-Host "Stopping $targetPath (PID $($process.ProcessId))"
  & taskkill.exe /PID $process.ProcessId /T /F | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to stop process $($process.ProcessId)"
  }
}

Write-Host "Waiting $DelaySeconds seconds before replacing the executable"
Start-Sleep -Seconds $DelaySeconds

$running = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $targetPath, [System.StringComparison]::OrdinalIgnoreCase)
})
if ($running.Count -gt 0) {
  throw "The target executable is still running"
}

Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
Write-Host "Replaced $targetPath"

Start-Process -FilePath $targetPath -WorkingDirectory (Split-Path $targetPath)
Write-Host "Started $targetPath"
