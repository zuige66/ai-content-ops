' start-scheduler.vbs -- launch the auto-reply scheduler silently (no console window)
' Put a shortcut to this file in the Startup folder to run it on login.
' Edit NODE_EXE below if the node path changes (WorkBuddy bundles its own node).

Option Explicit

Dim sh, fso, root, nodeExe, script

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = "D:\Workplace\zhibo-auto"
nodeExe = "C:\Users\lirui\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
script = root & "\tools\scheduler.mjs"

If Not fso.FileExists(script) Then
  WScript.Quit 1
End If

If Not fso.FileExists(nodeExe) Then
  ' fall back to whatever node is on PATH
  nodeExe = "node.exe"
End If

sh.CurrentDirectory = root
sh.Run """" & nodeExe & """ """ & script & """", 0, False
