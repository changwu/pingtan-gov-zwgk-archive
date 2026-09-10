# finalize.ps1 — run AFTER main crawl queue empties (watcher pwsh-17 exits).
# 1) retry failed docs/attachments (endgame.js retry) — crawler re-runs on requeued few
# 2) lists archive  (crawler.js --lists-only)
# 3) regenerate reports (report.js)
# 4) sync files into pt_repo + commit
# 5) push via Windows OpenSSH
# 6) integrity checks
$ErrorActionPreference = 'Continue'
$tools = 'C:\Users\user\Documents\pt_tools'
$repo = 'C:\Users\user\Documents\pt_repo'
$log = Join-Path $tools 'finalize.log'
if (Test-Path $log) { Remove-Item $log }
function Log($m) { Add-Content -Path $log -Value ((Get-Date).ToString('s') + ' ' + $m); Write-Output $m }

Log '=== FINALIZE step1: retry failed ==='
node (Join-Path $tools 'endgame.js') retry *>> $log
Log '=== FINALIZE step2: lists ==='
node (Join-Path $tools 'crawler.js') --lists-only *>> $log
Log '=== FINALIZE step3: reports ==='
node (Join-Path $tools 'report.js') *>> $log
Log '=== FINALIZE step4: sync files ==='
node (Join-Path $tools 'sync_files.js') *>> $log
Log '=== FINALIZE step5: commit + push ==='
Set-Location $repo
git add -A *>> $log
$count = node (Join-Path $tools 'get_done.js')
$msg = "Pingtan zwgk archive final: ~$($count.Split("`t")[0]) docs, retries + lists + reports"
git -c user.name='changwu' -c user.email='changwu@yeah.net' commit -m $msg *>> $log
$env:GIT_SSH_COMMAND = 'C:/Windows/System32/OpenSSH/ssh.exe'
git push origin master *>> $log
$h = git rev-parse HEAD; $rh = git rev-parse origin/master
Log "FINAL PUSH HEAD=$h origin=$rh match=$($h -eq $rh)"
Log '=== FINALIZE step6: integrity ==='
Push-Location 'C:\Users\user\Documents'
node (Join-Path $tools 'check_integrity2.js') *>> $log
node (Join-Path $tools 'status.js') *>> $log
Pop-Location
Log '=== FINALIZE DONE ==='
