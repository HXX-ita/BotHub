' start-tray.vbs -- launch the BotHub tray icon with NO console window at all.
'
' Why this file exists: launching the tray with  start "" /min powershell -WindowStyle Hidden ...
' still creates a console window (Windows Terminal hosts it on Windows 11), and because the tray
' runs a message loop forever that window never closes by itself -- the user ends up with a
' window he cannot get rid of. WScript.Shell.Run with window style 0 creates no window at all.
'
' ASCII-only. The script path is built from script-relative pieces so no Chinese and no
' absolute hardcoding is needed.

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)   ' ...\BotHub\tools
root      = fso.GetParentFolderName(scriptDir)                ' ...\BotHub
tray      = scriptDir & "\bothub-tray.ps1"
logDir    = root & "\data\logs"
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir) End If

cmd = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & tray & """"

' 0 = hidden window, False = do not wait
sh.Run cmd, 0, False
