' Starts the Mediarr system tray (which runs Mediarr in the background) without any console window.
' Double-click this file, or let "Start when Windows starts" run it at login.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\MediarrTray.ps1""", 0, False
