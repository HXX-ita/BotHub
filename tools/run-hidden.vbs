' run-hidden.vbs -- run a Node script from this folder with NO window at all.
'
' Usage: wscript.exe //nologo run-hidden.vbs <script.mjs> [args...]
'   e.g. wscript.exe //nologo run-hidden.vbs bothub-supervisor.mjs
'        wscript.exe //nologo run-hidden.vbs start-bothub-supervisor.mjs --ensure
'
' Why this exists: Task Scheduler runs console programs (node.exe) in the interactive session
' WITH a console window -- that window is what the boss kept seeing as "a node.exe command
' window". It stayed there for as long as the supervisor ran, and the every-minute ensure pass
' flashed another one. wscript.exe is a GUI-subsystem host with no console of its own, and
' Run(cmd, 0, False) starts node with a HIDDEN console.
'
' NOTE: pass the supervisor daemon itself for the "keep it running" task, and the --ensure
' script for the "make sure it is running" task. Mixing them up makes the ensure script
' re-trigger its own task (recursion) -- I did exactly that once.
'
' ASCII-only.

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)   ' ...\BotHub\tools

If WScript.Arguments.Count = 0 Then
  WScript.Quit 1
End If

scriptName = WScript.Arguments(0)
extra = ""
For i = 1 To WScript.Arguments.Count - 1
  extra = extra & " " & WScript.Arguments(i)
Next

' Find node WITHOUT hardcoding the author's machine:
'   1) runtime\node\node.exe shipped next to this script (portable install)
'   2) the path the app recorded in data\runtime.json (whoever installed it)
'   3) plain "node.exe" -- ShellExecute-style Run resolves that through PATH
root = fso.GetParentFolderName(scriptDir)
nodeExe = "node.exe"
portable = scriptDir & "\..\runtime\node\node.exe"
If fso.FileExists(portable) Then
  nodeExe = fso.GetAbsolutePathName(portable)
Else
  rt = root & "\data\runtime.json"
  If fso.FileExists(rt) Then
    On Error Resume Next
    Set f = fso.OpenTextFile(rt, 1)
    txt = f.ReadAll
    f.Close
    On Error GoTo 0
    pos = InStr(txt, """node""")
    If pos > 0 Then
      rest = Mid(txt, pos + 7)
      q1 = InStr(rest, """")
      If q1 > 0 Then
        rest = Mid(rest, q1 + 1)
        q2 = InStr(rest, """")
        If q2 > 0 Then
          cand = Replace(Mid(rest, 1, q2 - 1), "\\", "\")
          If fso.FileExists(cand) Then nodeExe = cand
        End If
      End If
    End If
  End If
End If

' 4) common install locations, then plain "node.exe" (PATH lookup)
If nodeExe = "node.exe" Then
  For Each cand In Array( _
      sh.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe"), _
      sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe"), _
      sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%\nodejs\node.exe"))
    If fso.FileExists(cand) Then
      nodeExe = cand
      Exit For
    End If
  Next
End If

cmd = """" & nodeExe & """ """ & scriptDir & "\" & scriptName & """" & extra
sh.Run cmd, 0, False