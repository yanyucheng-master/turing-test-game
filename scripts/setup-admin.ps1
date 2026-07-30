$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$templatePath = Join-Path $projectRoot ".env.admin.example"
$targetPath = Join-Path $projectRoot ".env.admin.local"

if (Test-Path -LiteralPath $targetPath) {
  Start-Process -FilePath "notepad.exe" -ArgumentList @($targetPath)
  exit 0
}

$bytes = New-Object byte[] 32
$generator = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $generator.GetBytes($bytes)
} finally {
  $generator.Dispose()
}
$token = -join ($bytes | ForEach-Object { $_.ToString("x2") })

$contents = [IO.File]::ReadAllText($templatePath)
$contents = [Text.RegularExpressions.Regex]::Replace(
  $contents,
  "(?m)^CULTURE_REVIEW_TOKEN=.*$",
  "CULTURE_REVIEW_TOKEN=$token"
)
$utf8WithoutBom = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText($targetPath, $contents, $utf8WithoutBom)

Write-Host "A 64-character random administrator token was created in .env.admin.local."
Write-Host "Fill in ADMIN_REMOTE_URL and copy CULTURE_REVIEW_TOKEN to the Render environment."
Start-Process -FilePath "notepad.exe" -ArgumentList @($targetPath)
