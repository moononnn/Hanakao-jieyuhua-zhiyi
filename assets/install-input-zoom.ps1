# Hana draft image zoom - installer helper.
#
# WHY THIS FILE IS ASCII ONLY, UTF-8 WITH BOM, CRLF:
# Windows PowerShell 5.1 (powershell.exe) decodes a BOM-less UTF-8 script with
# the system ANSI codepage (GBK on zh-CN). A multi-byte character right before a
# newline can swallow that newline, so the next line silently becomes part of a
# comment. That destroyed the param block, every call fell through to "status",
# and the UI reported "installed" while nothing had been written.
# Rule: keep this file pure ASCII, save it as UTF-8 WITH BOM, keep CRLF endings,
# and never depend on the param block alone to decide what to do.
#
# Usage:
#   powershell -NoProfile -File install-input-zoom.ps1 status
#   powershell -NoProfile -File install-input-zoom.ps1 install
#   powershell -NoProfile -File install-input-zoom.ps1 uninstall
#
# Optional switches:
#   -Root <path>   renderer root to operate on (default: %USERPROFILE%\.hanako\artifacts\renderer)
#
# Environment fallbacks (used when a switch did not survive parsing):
#   HDIZ_ACTION, HDIZ_ROOT
#
# Output: one JSON line on stdout.
param(
  [string]$Action = '',
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$scriptName = 'draft-image-zoom.js'
$scriptTag = '<script src="modules/draft-image-zoom.js" data-hdiz="1"></script>'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $here 'input-zoom-script.js'

function Resolve-Action {
  param([string]$Arg)
  $value = $Arg
  if (-not $value) { $value = $env:HDIZ_ACTION }
  if (-not $value) { $value = 'status' }
  return $value.Trim().ToLowerInvariant()
}

function Resolve-Root {
  param([string]$Arg)
  $value = $Arg
  if (-not $value) { $value = $env:HDIZ_ROOT }
  if (-not $value) { $value = Join-Path $env:USERPROFILE '.hanako\artifacts\renderer' }
  return $value
}

$action = Resolve-Action -Arg $Action
$root = Resolve-Root -Arg $Root

function Get-NewestRenderer {
  if (-not (Test-Path -LiteralPath $root)) { return $null }
  Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'index.html') } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
}

function Get-Version([string]$dirName) {
  if ($dirName -match '^(\d+\.\d+\.\d+[^-]*(?:-[a-z]+)?)') { return $Matches[1] }
  return $dirName
}

function Write-Result($payload) {
  $payload | ConvertTo-Json -Compress -Depth 6
  exit 0
}

function Read-Status {
  $dir = Get-NewestRenderer
  if (-not $dir) {
    return @{ ok = $true; found = $false; installed = $false; scriptPresent = $false; injected = $false; code = 'NO_DIR'; action = $action }
  }
  $index = Join-Path $dir.FullName 'index.html'
  $html = Get-Content -LiteralPath $index -Raw -Encoding UTF8
  $scriptPath = Join-Path $dir.FullName ('modules\' + $scriptName)
  $scriptPresent = Test-Path -LiteralPath $scriptPath
  $injected = $html -match 'data-hdiz="1"'
  return @{
    ok = $true
    found = $true
    installed = ($scriptPresent -and $injected)
    scriptPresent = $scriptPresent
    injected = $injected
    version = (Get-Version $dir.Name)
    dir = $dir.FullName
    code = 'OK'
    action = $action
  }
}

try {
  switch ($action) {
    'install' {
      $dir = Get-NewestRenderer
      if (-not $dir) { Write-Result @{ ok = $false; code = 'NO_DIR'; action = $action } }
      if (-not (Test-Path -LiteralPath $source)) { Write-Result @{ ok = $false; code = 'NO_SOURCE'; action = $action } }

      $modulesDir = Join-Path $dir.FullName 'modules'
      if (-not (Test-Path -LiteralPath $modulesDir)) {
        New-Item -ItemType Directory -Path $modulesDir | Out-Null
      }
      Copy-Item -LiteralPath $source -Destination (Join-Path $modulesDir $scriptName) -Force

      $index = Join-Path $dir.FullName 'index.html'
      $html = Get-Content -LiteralPath $index -Raw -Encoding UTF8
      if ($html -notmatch 'data-hdiz="1"') {
        $backup = $index + '.hdiz.bak'
        if (-not (Test-Path -LiteralPath $backup)) {
          Copy-Item -LiteralPath $index -Destination $backup -Force
        }
        if ($html -match '</body>') {
          $html = [regex]::Replace($html, '</body>', "    $scriptTag`r`n</body>", 1)
        } else {
          $html = $html + "`r`n" + $scriptTag + "`r`n"
        }
        [System.IO.File]::WriteAllText($index, $html, (New-Object System.Text.UTF8Encoding($false)))
      }

      # Read the files back before claiming success. A false "installed" here is
      # exactly the bug that made the button lie to the user.
      $status = Read-Status
      if (-not $status.installed) {
        $status['ok'] = $false
        $status['code'] = 'INSTALL_FAILED'
        $status['message'] = 'script or index.html injection was not found after writing'
        Write-Result $status
      }
      $status['justInstalled'] = $true
      Write-Result $status
    }
    'uninstall' {
      $dir = Get-NewestRenderer
      if (-not $dir) { Write-Result @{ ok = $false; code = 'NO_DIR'; action = $action } }
      $index = Join-Path $dir.FullName 'index.html'
      $html = Get-Content -LiteralPath $index -Raw -Encoding UTF8
      if ($html -match 'data-hdiz="1"') {
        $html = [regex]::Replace($html, '\s*<script[^>]*data-hdiz="1"[^>]*></script>', '')
        [System.IO.File]::WriteAllText($index, $html, (New-Object System.Text.UTF8Encoding($false)))
      }
      $scriptPath = Join-Path $dir.FullName ('modules\' + $scriptName)
      if (Test-Path -LiteralPath $scriptPath) { Remove-Item -LiteralPath $scriptPath -Force }
      $status = Read-Status
      if ($status.installed) {
        $status['ok'] = $false
        $status['code'] = 'UNINSTALL_FAILED'
        $status['message'] = 'still installed after removal'
        Write-Result $status
      }
      Write-Result $status
    }
    'status' {
      Write-Result (Read-Status)
    }
    default {
      Write-Result @{ ok = $false; code = 'BAD_ACTION'; action = $action; message = "unknown action: $action" }
    }
  }
} catch {
  Write-Result @{ ok = $false; code = 'FAILED'; action = $action; message = (String($_.Exception.Message)).Substring(0, [Math]::Min(160, (String($_.Exception.Message)).Length)) }
}
