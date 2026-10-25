# 输入框图片放大 · 安装助手
#
# 为什么要有这个文件：知意 App 跑在 Hana 的受限环境里，读不到 ~/.hanako/artifacts
# （ERR_ACCESS_DENIED）。安装要动 renderer 目录，所以交给这个独立进程去做。
#
# 用法：powershell -NoProfile -File install-input-zoom.ps1 status
#       powershell -NoProfile -File install-input-zoom.ps1 install
#       powershell -NoProfile -File install-input-zoom.ps1 uninstall
# 输出：一行 JSON 到 stdout，字段 ok / found / installed / code / version / dir。
param([string]$Action = "status")

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$scriptName = 'draft-image-zoom.js'
$scriptTag = '<script src="modules/draft-image-zoom.js" data-hdiz="1"></script>'
$root = Join-Path $env:USERPROFILE '.hanako\artifacts\renderer'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $here 'input-zoom-script.js'

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
    return @{ ok = $true; found = $false; installed = $false; code = 'NO_DIR' }
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
  }
}

try {
  switch ($Action) {
    'install' {
      $dir = Get-NewestRenderer
      if (-not $dir) { Write-Result @{ ok = $false; code = 'NO_DIR' } }
      if (-not (Test-Path -LiteralPath $source)) { Write-Result @{ ok = $false; code = 'NO_SOURCE' } }

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
      $status = Read-Status
      $status['justInstalled'] = $true
      Write-Result $status
    }
    'uninstall' {
      $dir = Get-NewestRenderer
      if (-not $dir) { Write-Result @{ ok = $false; code = 'NO_DIR' } }
      $index = Join-Path $dir.FullName 'index.html'
      $html = Get-Content -LiteralPath $index -Raw -Encoding UTF8
      if ($html -match 'data-hdiz="1"') {
        $html = [regex]::Replace($html, '\s*<script[^>]*data-hdiz="1"[^>]*></script>', '')
        [System.IO.File]::WriteAllText($index, $html, (New-Object System.Text.UTF8Encoding($false)))
      }
      $scriptPath = Join-Path $dir.FullName ('modules\' + $scriptName)
      if (Test-Path -LiteralPath $scriptPath) { Remove-Item -LiteralPath $scriptPath -Force }
      Write-Result (Read-Status)
    }
    default {
      Write-Result (Read-Status)
    }
  }
} catch {
  Write-Result @{ ok = $false; code = 'FAILED'; message = (String($_.Exception.Message)).Substring(0, [Math]::Min(160, (String($_.Exception.Message)).Length)) }
}
