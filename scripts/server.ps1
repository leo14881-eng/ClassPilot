<#
ClassPilot 服务器维护（在 Windows 电脑上运行，通过 SSH 连到云服务器）。
只执行下面这些固定动作，不提供执行任意命令的通道；配置文件由脚本直接上传，不在屏幕或日志里显示内容。

  check          检查服务器能否访问 OpenRouter / OpenAI / GitHub
  install        在服务器上安装或重装（从 GitHub 拉取 scripts/linux/install.sh 执行）
  status         服务器上的服务状态、版本、最近日志
  upload-config  上传 config\config.json（口令和 API Key）到服务器并重启服务
  restart        重启服务器上的 ClassPilot 服务

用法（在 ClassPilot 目录里）：
  powershell -ExecutionPolicy Bypass -File scripts\server.ps1 status
不带参数时，处理 app\server.request 里写的动作（给计划任务用，见 scripts\install-bridge.ps1），输出写 logs\server.log。

SSH 密钥沿用 TrendPilot 的：D:\SOFT\java\TrendPilot\ssh\id_ed25519（只引用路径，不复制、不打印）。
#>
param([string]$Action = '')

$ErrorActionPreference = 'Continue'
$AppDir = Split-Path -Parent $PSScriptRoot
$Bin = Join-Path $AppDir 'app'
$LogDir = Join-Path $AppDir 'logs'
$SshDir = Join-Path $AppDir 'ssh'
New-Item -ItemType Directory -Force -Path $Bin, $LogDir, $SshDir | Out-Null
$LogFile = Join-Path $LogDir 'server.log'

$ServerIp = '202.182.114.123'
$ipFile = Join-Path $Bin 'server-ip.txt'
if (Test-Path $ipFile) { $ServerIp = (Get-Content $ipFile -Raw).Trim() }
$Key = 'D:\SOFT\java\TrendPilot\ssh\id_ed25519'
$keyFile = Join-Path $Bin 'ssh-key-path.txt'
if (Test-Path $keyFile) { $Key = (Get-Content $keyFile -Raw).Trim() }

$Interactive = $Action -ne ''
function Write-Out($msg) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
    if ($Interactive) { Write-Host $msg }
}

$BootClone = 'command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git >/dev/null; }; rm -rf /tmp/cp-boot && git clone -q --depth 1 https://github.com/leo14881-eng/ClassPilot.git /tmp/cp-boot'
$Remote = @{
    check   = "$BootClone && bash /tmp/cp-boot/scripts/linux/install.sh --check"
    install = "$BootClone && bash /tmp/cp-boot/scripts/linux/install.sh"
    status  = 'bash /opt/classpilot/scripts/linux/status.sh'
    restart = 'systemctl restart classpilot.service && sleep 3 && systemctl is-active classpilot.service'
    'apply-config' = 'id classpilot >/dev/null 2>&1 && chown classpilot:classpilot /opt/classpilot/config/config.json; chmod 600 /opt/classpilot/config/config.json && systemctl restart classpilot.service && sleep 3 && echo "服务 $(systemctl is-active classpilot.service)"'
}

function Invoke-Tool($exe, $argLine, $stdinText) {
    $tmpIn = Join-Path $Bin 'server-in.tmp'; $tmpOut = Join-Path $Bin 'server-out.tmp'; $tmpErr = Join-Path $Bin 'server-err.tmp'
    $p = @{ FilePath = $exe; ArgumentList = $argLine; NoNewWindow = $true; PassThru = $true; RedirectStandardOutput = $tmpOut; RedirectStandardError = $tmpErr }
    if ($stdinText) {
        [IO.File]::WriteAllText($tmpIn, $stdinText + "`n", (New-Object Text.UTF8Encoding $false))
        $p.RedirectStandardInput = $tmpIn
    }
    $proc = Start-Process @p
    $null = $proc.Handle
    if (-not $proc.WaitForExit(40 * 60 * 1000)) { try { $proc.Kill() } catch { }; Write-Out '超过 40 分钟，已中止' }
    foreach ($f in $tmpOut, $tmpErr) {
        if (Test-Path $f) {
            $text = [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8).TrimEnd()
            if ($text) { Write-Out $text }
        }
    }
    Remove-Item $tmpIn, $tmpOut, $tmpErr -ErrorAction SilentlyContinue
    return $proc.ExitCode
}

if (-not $Interactive) {
    $request = Join-Path $Bin 'server.request'
    if (-not (Test-Path $request)) { exit 0 }
    $Action = (Get-Content $request -Raw).Trim().ToLower()
    Remove-Item $request -Force -ErrorAction SilentlyContinue
}
$Action = $Action.ToLower()
$allowed = @('check', 'install', 'status', 'upload-config', 'restart')
if ($allowed -notcontains $Action) { Write-Out "未知动作：$Action（可用：$($allowed -join ', ')）"; exit 1 }
if ($ServerIp -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { Write-Out "服务器 IP 无效：$ServerIp"; exit 1 }

$ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$scp = Join-Path $env:WINDIR 'System32\OpenSSH\scp.exe'
if (-not (Test-Path $Key)) { Write-Out "找不到 SSH 密钥：$Key"; exit 1 }
if (-not (Test-Path $ssh)) { Write-Out '找不到系统自带的 ssh（Windows 设置 > 可选功能 > OpenSSH 客户端）'; exit 1 }
& icacls.exe $Key /inheritance:r /grant:r "$($env:USERNAME):F" 2>&1 | Out-Null
$opts = "-i `"$Key`" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o `"UserKnownHostsFile=$(Join-Path $SshDir 'known_hosts')`" -o ConnectTimeout=20 -o ServerAliveInterval=30"

Write-Out "== $Action"
if ($Action -eq 'upload-config') {
    $cfg = Join-Path $AppDir 'config\config.json'
    if (-not (Test-Path $cfg)) { Write-Out '找不到 config\config.json：先复制 config\config.example.json 为 config.json 并填好'; exit 1 }
    try { $null = Get-Content $cfg -Raw | ConvertFrom-Json } catch { Write-Out 'config\config.json 不是有效的 JSON，请检查逗号和引号'; exit 1 }
    $code = Invoke-Tool $ssh "$opts root@$ServerIp bash -s" 'mkdir -p /opt/classpilot/config && chmod 700 /opt/classpilot/config'
    if ($code -eq 0) { $code = Invoke-Tool $scp "$opts -q `"$cfg`" root@${ServerIp}:/opt/classpilot/config/config.json" $null }
    Write-Out "上传配置：退出码 $code"
    if ($code -eq 0) { $code = Invoke-Tool $ssh "$opts root@$ServerIp bash -s" $Remote['apply-config'] }
} else {
    $code = Invoke-Tool $ssh "$opts root@$ServerIp bash -s" $Remote[$Action]
}
Write-Out "退出码 $code"
exit $code
