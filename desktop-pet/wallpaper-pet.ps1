# wallpaper-pet.ps1 — 壁纸桌面宠物：悬浮小猫 + 设置拖动条 + 图片开关
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$settingsPath = if ($env:DSH_HOME) { Join-Path $env:DSH_HOME 'wallpaper-settings.json' } else { 'C:\Users\Administrator\.dsh\wallpaper-settings.json' }

function Read-Settings {
  try {
    if (Test-Path $settingsPath) {
      $j = Get-Content $settingsPath -Raw | ConvertFrom-Json
      $dis = @($j.disabled | Where-Object { $_ -ne $null })
      return @{
        opacity = [double]$j.opacity
        intervalSec = [int]$j.intervalSec
        disabled = $dis
        nextTick = [int]$j.nextTick
      }
    }
  } catch {}
  return @{ opacity = 0.28; intervalSec = 180; disabled = @(); nextTick = 0 }
}

function Write-Settings {
  try {
    $obj = [ordered]@{
      opacity = [double]$script:opacity
      intervalSec = [int]$script:intervalSec
      disabled = @($script:disabled | Where-Object { $_ -ne $null })
      nextTick = [int]$script:nextTick
    }
    ($obj | ConvertTo-Json) | Set-Content $settingsPath -Encoding UTF8
  } catch {}
}

function Get-ImageList {
  $list = @()
  $exts = @('.jpg', '.jpeg', '.png', '.webp', '.gif')
  $workshop = 'E:\steam\steamapps\workshop\content\431960'
  if (Test-Path $workshop) {
    Get-ChildItem $workshop -Directory | ForEach-Object {
      $folder = $_.Name
      $pv = Get-ChildItem $_.FullName -File | Where-Object { $_.Name -match '^preview\.' -and ($exts -contains $_.Extension.ToLower()) } | Select-Object -First 1
      if ($pv) { $list += "workshop/$folder/$($pv.Name)" }
    }
  }
  $myprojects = 'E:\steam\steamapps\common\wallpaper_engine\projects\myprojects'
  if (Test-Path $myprojects) {
    Get-ChildItem $myprojects -Directory | ForEach-Object {
      $proj = $_.Name
      Get-ChildItem $_.FullName -File | Where-Object { $_.Name -match '^preview\.' -and ($exts -contains $_.Extension.ToLower()) } | ForEach-Object {
        $list += "local/$proj/$($_.Name)"
      }
      $mats = Join-Path $_.FullName 'materials'
      if (Test-Path $mats) {
        Get-ChildItem $mats -File | Where-Object { $exts -contains $_.Extension.ToLower() } | ForEach-Object {
          $list += "local/$proj/materials/$($_.Name)"
        }
      }
    }
  }
  return ($list | Sort-Object)
}

$s = Read-Settings
$script:opacity = $s.opacity
$script:intervalSec = $s.intervalSec
$script:disabled = $s.disabled
$script:nextTick = $s.nextTick

# ---------- 宠物窗口 ----------
$pet = New-Object System.Windows.Forms.Form
$pet.FormBorderStyle = 'None'
$pet.TopMost = $true
$pet.ShowInTaskbar = $false
$pet.StartPosition = 'Manual'
$pet.Size = New-Object System.Drawing.Size(92, 92)
$pet.Location = New-Object System.Drawing.Point(120, 120)
$pet.BackColor = [System.Drawing.Color]::FromArgb(255, 48, 48, 54)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddEllipse(0, 0, 92, 92)
$pet.Region = New-Object System.Drawing.Region($path)

$emoji = New-Object System.Windows.Forms.Label
$emoji.Text = [char]::ConvertFromUtf32(0x1F431)
$emoji.Font = New-Object System.Drawing.Font('Segoe UI Emoji', 50)
$emoji.BackColor = [System.Drawing.Color]::FromArgb(255, 48, 48, 54)
$emoji.Size = New-Object System.Drawing.Size(84, 84)
$emoji.Location = New-Object System.Drawing.Point(6, 4)
$emoji.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$pet.Controls.Add($emoji)

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$exitItem = $menu.Items.Add('退出宠物')
$exitItem.Add_Click({ $pet.Close(); $bar.Close(); [System.Windows.Forms.Application]::Exit() })
$emoji.ContextMenuStrip = $menu

# ---------- 设置拖动条窗口 ----------
$bar = New-Object System.Windows.Forms.Form
$bar.FormBorderStyle = 'FixedToolWindow'
$bar.TopMost = $true
$bar.ShowInTaskbar = $false
$bar.StartPosition = 'Manual'
$bar.Size = New-Object System.Drawing.Size(336, 452)
$bar.Text = '壁纸设置'
$bar.MaximizeBox = $false
$bar.MinimizeBox = $false

$lbl1 = New-Object System.Windows.Forms.Label
$lbl1.Text = '透明度（越大图片越清晰）'
$lbl1.Location = New-Object System.Drawing.Point(12, 12)
$lbl1.AutoSize = $true

$tbOp = New-Object System.Windows.Forms.TrackBar
$tbOp.Minimum = 5
$tbOp.Maximum = 95
$tbOp.TickFrequency = 10
$tbOp.Location = New-Object System.Drawing.Point(10, 36)
$tbOp.Size = New-Object System.Drawing.Size(230, 40)
$tbOp.Value = [int](100 - $script:opacity * 100)

$lbl1v = New-Object System.Windows.Forms.Label
$lbl1v.Location = New-Object System.Drawing.Point(248, 14)
$lbl1v.AutoSize = $true

$lbl2 = New-Object System.Windows.Forms.Label
$lbl2.Text = '轮换间隔（秒）'
$lbl2.Location = New-Object System.Drawing.Point(12, 88)
$lbl2.AutoSize = $true

$tbIv = New-Object System.Windows.Forms.TrackBar
$tbIv.Minimum = 30
$tbIv.Maximum = 600
$tbIv.TickFrequency = 30
$tbIv.Location = New-Object System.Drawing.Point(10, 112)
$tbIv.Size = New-Object System.Drawing.Size(230, 40)
$tbIv.Value = [int]$script:intervalSec

$lbl2v = New-Object System.Windows.Forms.Label
$lbl2v.Location = New-Object System.Drawing.Point(248, 90)
$lbl2v.AutoSize = $true

$lbl3 = New-Object System.Windows.Forms.Label
$lbl3.Text = '轮换图片（勾选=启用，取消=停用）'
$lbl3.Location = New-Object System.Drawing.Point(12, 158)
$lbl3.AutoSize = $true

$clb = New-Object System.Windows.Forms.CheckedListBox
$clb.Location = New-Object System.Drawing.Point(12, 180)
$clb.Size = New-Object System.Drawing.Size(300, 200)
$clb.CheckOnClick = $true

$btnNext = New-Object System.Windows.Forms.Button
$btnNext.Text = '换一张'
$btnNext.Location = New-Object System.Drawing.Point(12, 392)
$btnNext.Size = New-Object System.Drawing.Size(90, 30)

$btnRefresh = New-Object System.Windows.Forms.Button
$btnRefresh.Text = '刷新列表'
$btnRefresh.Location = New-Object System.Drawing.Point(110, 392)
$btnRefresh.Size = New-Object System.Drawing.Size(90, 30)

$btn = New-Object System.Windows.Forms.Button
$btn.Text = '收起'
$btn.Location = New-Object System.Drawing.Point(208, 392)
$btn.Size = New-Object System.Drawing.Size(104, 30)

$bar.Controls.AddRange(@($lbl1, $tbOp, $lbl1v, $lbl2, $tbIv, $lbl2v, $lbl3, $clb, $btnNext, $btnRefresh, $btn))

function Refresh-Labels {
  $t = 100 - [int]($script:opacity * 100)
  $lbl1v.Text = "$t%"
  $lbl2v.Text = "$($script:intervalSec) 秒 ($([math]::Round($script:intervalSec / 60, 1)) 分)"
}

function Reload-ImageList {
  $images = Get-ImageList
  $clb.Items.Clear()
  foreach ($img in $images) {
    [void]$clb.Items.Add($img, ($script:disabled -notcontains $img))
  }
}

$tbOp.Add_ValueChanged({
  $t = $tbOp.Value
  $script:opacity = [math]::Round((100 - $t) / 100, 2)
  Write-Settings
  $lbl1v.Text = "$t%"
})

$tbIv.Add_ValueChanged({
  $script:intervalSec = [int]$tbIv.Value
  Write-Settings
  $lbl2v.Text = "$($script:intervalSec) 秒 ($([math]::Round($script:intervalSec / 60, 1)) 分)"
})

$clb.Add_ItemCheck({
  $name = $clb.Items[$_.Index].ToString()
  $willCheck = ($_.NewValue -eq [System.Windows.Forms.CheckState]::Checked)
  if ($willCheck) {
    $script:disabled = @($script:disabled | Where-Object { $_ -ne $name })
  } else {
    if ($script:disabled -notcontains $name) { $script:disabled += $name }
  }
  Write-Settings
})

$btnNext.Add_Click({ $script:nextTick++; Write-Settings })
$btnRefresh.Add_Click({ Reload-ImageList })
$btn.Add_Click({ $bar.Hide() })

# ---------- 拖动 / 单击切换 ----------
$script:downPos = $null
$script:moved = $false
$emoji.Add_MouseDown({ $script:downPos = New-Object System.Drawing.Point($_.X, $_.Y); $script:moved = $false })
$emoji.Add_MouseMove({
  if ($script:downPos -ne $null) {
    $dx = $_.X - $script:downPos.X
    $dy = $_.Y - $script:downPos.Y
    if ([math]::Abs($dx) -gt 3 -or [math]::Abs($dy) -gt 3) { $script:moved = $true }
    $pet.Location = New-Object System.Drawing.Point(($pet.Location.X + $dx), ($pet.Location.Y + $dy))
  }
})
$emoji.Add_MouseUp({
  $script:downPos = $null
  if (-not $script:moved) {
    if ($bar.Visible) {
      $bar.Hide()
    } else {
      Reload-ImageList
      $bar.Location = New-Object System.Drawing.Point([math]::Max(0, $pet.Location.X), ($pet.Location.Y + $pet.Height + 4))
      $bar.Show()
      $bar.TopMost = $true
      $bar.Activate()
    }
  }
})

Refresh-Labels
[System.Windows.Forms.Application]::Run($pet)
