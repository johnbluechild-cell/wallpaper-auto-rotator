#requires -Version 5.1
<#
  把 plugin/ 装到 DSH 桌面端的 profile 里（Windows）

  做三件事（都可回滚）：
    1. 备份 profiles\desktop\cordis.patch.yml
    2. 在 profiles\desktop\node_modules\ 下建立指向本仓库 plugin/ 的目录链接
       —— junction 是重解析点，本体仍在仓库里，不会复制一份到 C 盘
    3. 在补丁末尾追加一条 insert（已存在则跳过）

  不修改注册表、不建计划任务、不碰桌面壁纸。

  用法：
    powershell -ExecutionPolicy Bypass -File .\deploy-desktop.ps1
    powershell -ExecutionPolicy Bypass -File .\deploy-desktop.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$Name = 'wallpaper-rotator-v2',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$Prof = Join-Path $DshHome 'profiles\desktop'
$Patch = Join-Path $Prof 'cordis.patch.yml'
$NodeModules = Join-Path $Prof 'node_modules'
$Link = Join-Path $NodeModules $Name
$Source = Join-Path $RepoRoot 'plugin'

if (-not (Test-Path $Prof)) { throw "找不到桌面端 profile：$Prof" }
if (-not (Test-Path $Patch)) { throw "找不到补丁文件：$Patch" }

function Backup-Patch {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Copy-Item $Patch "$Patch.bak-$stamp"
  Write-Host "[deploy] 补丁已备份 -> $Patch.bak-$stamp"
}

if ($Uninstall) {
  Backup-Patch
  $lines = Get-Content $Patch
  $out = @()
  $skipping = $false
  foreach ($l in $lines) {
    if ($l -match '^\s*-\s*insert:\s*$' -and -not $skipping) { $skipping = $true; continue }
    if ($skipping) {
      if ($l -match '^\s+-\s+id:') { continue }
      if ($l -match '^\s{4,}') { continue }
      $skipping = $false
    }
    $out += $l
  }
  Set-Content $Patch ($out -join "`r`n") -Encoding UTF8
  if (Test-Path $Link) { (Get-Item $Link -Force).Delete() }
  Write-Host "[deploy] 已卸载，重启 DSH 生效"
  exit 0
}

if (-not (Test-Path (Join-Path $Source 'index.js'))) { throw "仓库里找不到 plugin/index.js：$Source" }

Backup-Patch
New-Item -ItemType Directory -Force -Path $NodeModules | Out-Null
if (Test-Path $Link) { (Get-Item $Link -Force).Delete() }
cmd /c "mklink /J `"$Link`" `"$Source`"" | Out-Null
if (-not (Test-Path (Join-Path $Link 'index.js'))) { throw "目录链接创建失败：$Link" }
Write-Host "[deploy] 已链接 $Name -> $Source"

$text = Get-Content $Patch -Raw
if ($text -notmatch [regex]::Escape($Name)) {
  $block = @"

# $Name
- insert:
    - id: $Name
      name: $Name
"@
  Add-Content -Path $Patch -Value $block -Encoding UTF8
  Write-Host "[deploy] 已写入 insert 配置"
} else {
  Write-Host "[deploy] 配置已存在，跳过"
}

Write-Host ''
Write-Host '[deploy] 完成：托盘右键完全退出 DSH，再启动即可'
Write-Host "回滚：powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Uninstall"
