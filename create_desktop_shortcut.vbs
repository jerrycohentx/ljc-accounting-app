' Runs CREATE-WEB-SHORTCUT.bat in a visible window (fixes silent double-click)
Option Explicit
Dim oShell, sFolder, bat
Set oShell = CreateObject("WScript.Shell")
sFolder = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
bat = sFolder & "\CREATE-WEB-SHORTCUT.bat"
If Not CreateObject("Scripting.FileSystemObject").FileExists(bat) Then
    MsgBox "Missing CREATE-WEB-SHORTCUT.bat in:" & vbCrLf & sFolder, vbCritical, "Cohen Entities AI Accounting"
    WScript.Quit 1
End If
oShell.Run """" & bat & """", 1, True
