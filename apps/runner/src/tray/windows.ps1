Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PiTrayIcon { [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr hIcon); }'
$lastIcon = ''; $lastTasks = -1
$zh = [Globalization.CultureInfo]::CurrentUICulture.TwoLetterISOLanguageName -eq 'zh'
function L($a,$b) { if ($zh) { $a } else { $b } }
$tray = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$state = $menu.Items.Add('Pi Bot Runner'); $state.Enabled = $false
$pair = $menu.Items.Add((L '配对…' 'Pair…'))
$logs = $menu.Items.Add((L '打开日志' 'Open logs'))
$quit = $menu.Items.Add((L '退出' 'Quit'))
$tray.ContextMenuStrip = $menu
$tray.Visible = $true
$form = $null
$paired = $false
$pair.Add_Click({
  if ($script:paired -and [System.Windows.Forms.MessageBox]::Show((L '更换已配对的电脑？' 'Replace the paired computer?'), 'Pi Bot Runner', 'YesNo', 'Question') -ne 'Yes') { return }
  $dialog = New-Object Windows.Forms.Form; $dialog.Text = L '配对执行端' 'Pair runner'; $dialog.Width=500; $dialog.Height=210
  $label = New-Object Windows.Forms.Label; $label.Text=L '粘贴电脑上「添加执行端」给出的配对码：' 'Paste the code from Add runner on your computer:'; $label.SetBounds(15,15,460,25)
  $inputCode = New-Object Windows.Forms.TextBox; $inputCode.SetBounds(15,45,450,25); $inputCode.MaxLength=1152
  $submit = New-Object Windows.Forms.Button; $submit.Text=L '配对' 'Pair'; $submit.SetBounds(370,85,90,30); $submit.DialogResult='OK'
  $cancel = New-Object Windows.Forms.Button; $cancel.Text=L '取消' 'Cancel'; $cancel.SetBounds(270,85,90,30); $cancel.DialogResult='Cancel'
  $legacy = New-Object Windows.Forms.LinkLabel; $legacy.Text=L '显示本机配对码（旧方式）' 'Show local code (legacy)'; $legacy.SetBounds(15,125,320,25)
  $legacy.Add_Click({ $dialog.DialogResult='Retry'; $dialog.Close() })
  $dialog.Controls.AddRange(@($label,$inputCode,$submit,$cancel,$legacy)); $dialog.AcceptButton=$submit; $dialog.CancelButton=$cancel
  try {
    $result=$dialog.ShowDialog()
    if ($result -eq 'OK') { [Console]::Out.WriteLine('pair-code:' + $inputCode.Text.Trim()); [Console]::Out.Flush() }
    elseif ($result -eq 'Retry') { [Console]::Out.WriteLine('pair'); [Console]::Out.Flush() }
  } finally { $dialog.Dispose() }
})
$logs.Add_Click({ [Console]::Out.WriteLine('logs'); [Console]::Out.Flush() })
$quit.Add_Click({ $quit.Enabled = $false; [Console]::Out.WriteLine('quit'); [Console]::Out.Flush() })
$read = [Console]::In.ReadLineAsync()
$timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 100
$timer.Add_Tick({
  if (-not $script:read.IsCompleted) { return }
  $line = $script:read.Result
  if ($null -eq $line) { [System.Windows.Forms.Application]::Exit(); return }
  $script:read = [Console]::In.ReadLineAsync()
  try { $v = $line | ConvertFrom-Json } catch { return }
  if ($v.statusUnavailable) { $state.Text = L '状态暂不可用' 'Status temporarily unavailable'; $tray.Text = $state.Text }
  if ($v.close) { [System.Windows.Forms.Application]::Exit(); return }
  if ($v.error) { $quit.Enabled = $true; $tray.ShowBalloonTip(5000,'Pi Bot Runner',$(if ($v.error -eq 'runner_pair_failed') { L '配对码无效或已过期，请在电脑上重新生成' 'Invalid or expired code. Generate a new code on your computer.' } else { L '操作失败，请查看日志。' 'Operation failed. Open logs for details.' }), 'Warning') }
  if ($null -ne $v.status) {
    $script:paired = $v.status.paired
    $connection = if (-not $script:paired) { L '未配对' 'Unpaired' } elseif ($v.status.connection -eq 'online') { L '在线' 'Online' } else { L '离线' 'Offline' }
    $tasks = [int]$v.status.runningCommands + [int]$v.status.backgroundTasks
    $label = "$($v.status.name) · $connection · $($v.status.path) · $(L '任务' 'Tasks'): $tasks"
    $state.Text = $label; $tray.Text = $label.Substring(0,[Math]::Min(63,$label.Length))
    if ($v.icon -and [IO.File]::Exists($v.icon) -and ($script:lastIcon -ne $v.icon -or $script:lastTasks -ne $tasks)) {
      $bitmap = New-Object System.Drawing.Bitmap($v.icon)
      if ($tasks -gt 0) { $g = [Drawing.Graphics]::FromImage($bitmap); $g.FillEllipse([Drawing.Brushes]::Red,22,22,10,10); $g.Dispose() }
      $handle = $bitmap.GetHicon()
      try { $temporary = [Drawing.Icon]::FromHandle($handle); $newIcon = $temporary.Clone(); $temporary.Dispose() } finally { [void][PiTrayIcon]::DestroyIcon($handle) }
      $script:lastIcon=$v.icon; $script:lastTasks=$tasks
      $old = $tray.Icon; $tray.Icon = $newIcon
      if ($old) { $old.Dispose() }; $bitmap.Dispose()
    }
  }
  if ($v.connecting) { $v | Add-Member -NotePropertyName pairing -NotePropertyValue ((L '正在连接 ' 'Connecting to ') + $v.connecting + ' …') }
  if ($v.PSObject.Properties.Name -contains 'pairing') {
    if ($v.pairing) {
      if ($null -eq $script:form -or $script:form.IsDisposed) {
        $script:form = New-Object Windows.Forms.Form; $script:form.Text = L '配对执行端' 'Pair runner'; $script:form.Width=470; $script:form.Height=150
        $script:code = New-Object Windows.Forms.TextBox; $script:code.ReadOnly=$true; $script:code.Width=420; $script:code.Left=15; $script:code.Top=15
        $copy = New-Object Windows.Forms.Button; $copy.Text=L '复制' 'Copy'; $copy.Top=50; $copy.Left=15
        $copy.Add_Click({ [Windows.Forms.Clipboard]::SetText($script:code.Text) })
        $script:form.Controls.Add($script:code); $script:form.Controls.Add($copy)
      }
      $script:code.Text=$v.pairing; $script:form.Show(); $script:form.Activate()
    } elseif ($script:form) { $script:form.Close(); $script:form=$null }
  }
})
$timer.Start()
try { [Windows.Forms.Application]::Run() } finally { $timer.Dispose(); if ($form) { $form.Dispose() }; $tray.Visible=$false; $tray.Dispose(); $menu.Dispose() }
