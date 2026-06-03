$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$KiloHome = if ($env:KILO_HOME) { $env:KILO_HOME } else { Join-Path $HOME ".config\kilo" }
$Skills = Join-Path $KiloHome "skills\vscode-self-test"
$Scripts = Join-Path $KiloHome "scripts\vscode-self-test"

New-Item -ItemType Directory -Force -Path (Join-Path $KiloHome "skills"), (Join-Path $KiloHome "scripts") | Out-Null
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Skills, $Scripts
Copy-Item -Recurse (Join-Path $Root "skills\vscode-self-test") $Skills
Copy-Item -Recurse (Join-Path $Root "src") $Scripts
Copy-Item (Join-Path $Root "package.json"), (Join-Path $Root "package-lock.json") $Scripts
Push-Location $Scripts
try {
  npm install --omit=dev
} finally {
  Pop-Location
}

Write-Host "Installed Kilo skill: $Skills"
Write-Host "Installed self-test CLI: $(Join-Path $Scripts 'cli.mjs')"
