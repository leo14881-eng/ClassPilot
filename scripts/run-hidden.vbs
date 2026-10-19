' Run a PowerShell script without a window: wscript run-hidden.vbs "<full path to script>"
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & WScript.Arguments(0) & """", 0, True
