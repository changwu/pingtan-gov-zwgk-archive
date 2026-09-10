# Batch pusher watcher: every 120s check done count; when >= +2500 since last push,
# sync files into pt_repo, commit, and push via Windows OpenSSH.
$ErrorActionPreference = 'Continue'
$tools = 'C:\Users\user\Documents\pt_tools'
$repo = 'C:\Users\user\Documents\pt_repo'
$marker = Join-Path $tools '.last_push_done'
$log = Join-Path $tools 'batch_watcher.log'
function Log($m) {
  $line = (Get-Date).ToString('s') + ' ' + $m
  Add-Content -Path $log -Value $line
  Write-Output $line
}
if (-not (Test-Path $marker)) { Set-Content -Path $marker -Value '38509' }
$last = [int](Get-Content $marker)
Log "watcher start last=$last"
while ($true) {
  Start-Sleep -Seconds 120
  $prog = node (Join-Path $tools 'get_done.js') 2>$null
  if (-not $prog -or $prog -like 'ERR*') { Log "probe fail: $prog"; continue }
  $parts = $prog -split "`t"
  $done = [int]$parts[0]; $queued = [int]$parts[1]; $failed = [int]$parts[2]; $phase = $parts[3]
  if ($done -ge $last + 2500) {
    Log "threshold: done=$done last=$last -> syncing"
    node (Join-Path $tools 'sync_files.js') *>> $log
    Set-Location $repo
    git add -A *>> $log
    $msg = "Pingtan zwgk archive update: ~$done docs (batch auto)"
    git -c user.name='changwu' -c user.email='changwu@yeah.net' commit -m $msg *>> $log
    $env:GIT_SSH_COMMAND = 'C:/Windows/System32/OpenSSH/ssh.exe'
    git push origin master *>> $log
    $h = git rev-parse HEAD
    $rh = git rev-parse origin/master
    Log "push done HEAD=$h origin=$rh match=$($h -eq $rh)"
    $last = $done
    Set-Content -Path $marker -Value ([string]$done)
  } else {
    Log "check done=$done queued=$queued failed=$failed phase=$phase (next push at $($last+2500))"
  }
  if ($phase -eq 'finished') {
    if ($done -gt $last) {
      Log "final sync: done=$done last=$last"
      node (Join-Path $tools 'sync_files.js') *>> $log
      Set-Location $repo
      git add -A *>> $log
      $msg = "Pingtan zwgk archive update: ~$done docs (final batch)"
      git -c user.name='changwu' -c user.email='changwu@yeah.net' commit -m $msg *>> $log
      $env:GIT_SSH_COMMAND = 'C:/Windows/System32/OpenSSH/ssh.exe'
      git push origin master *>> $log
      $h = git rev-parse HEAD; $rh = git rev-parse origin/master
      Log "final push done HEAD=$h origin=$rh match=$($h -eq $rh)"
      $last = $done
      Set-Content -Path $marker -Value ([string]$done)
    }
    Log 'crawl finished + repo current; watcher exit'
    break
  }
}
