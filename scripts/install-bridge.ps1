<#
可选：注册计划任务 ClassPilot-ServerBridge，每 3 分钟运行一次 scripts\server.ps1（不带参数），
处理 app\server.request 里写的固定动作名（check / install / status / upload-config / restart），结果写 logs\server.log。
这样 Claude 可以通过写请求文件来维护服务器，而不需要任意命令权限。普通用户权限即可。
卸载：Unregister-ScheduledTask ClassPilot-ServerBridge
#>
$ErrorActionPreference = 'Stop'
$AppDir = Split-Path -Parent $PSScriptRoot
$user = "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$script = Join-Path $AppDir 'scripts\server.ps1'
$vbs = Join-Path $AppDir 'scripts\run-hidden.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //Nologo `"$vbs`" `"$script`"" -WorkingDirectory $AppDir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 3)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName 'ClassPilot-ServerBridge' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'ClassPilot server maintenance bridge (fixed actions only)' -Force | Out-Null
Write-Host '已注册计划任务 ClassPilot-ServerBridge（每 3 分钟检查 app\server.request）'
