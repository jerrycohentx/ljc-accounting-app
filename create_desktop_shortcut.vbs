' Creates desktop + taskbar shortcuts → https://ljc-accounting-app.onrender.com
' Double-click this file (same as INSTALL-SHORTCUTS.bat)
Option Explicit

Const APP_URL = "https://ljc-accounting-app.onrender.com"

Dim oShell, oFSO, desktop, taskbar, urlBody, names, n, p, label

Set oShell = CreateObject("WScript.Shell")
Set oFSO = CreateObject("Scripting.FileSystemObject")

desktop = oShell.SpecialFolders("Desktop")
taskbar = oShell.ExpandEnvironmentStrings("%APPDATA%") & "\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"

urlBody = "[InternetShortcut]" & vbCrLf & _
          "URL=" & APP_URL & vbCrLf & _
          "IconIndex=0" & vbCrLf

names = Array( _
    "LJC AI Accounting.lnk", _
    "LJC Accounting.lnk", _
    "LJC AI Accounting.url", _
    "LJC Accounting.url", _
    "Cohen Entities AI Accounting.lnk", _
    "Cohen Entities AI Accounting.url" _
)
For Each n In names
    p = desktop & "\" & n
    If oFSO.FileExists(p) Then oFSO.DeleteFile p, True
    p = taskbar & "\" & n
    If oFSO.FileExists(p) Then oFSO.DeleteFile p, True
Next

For Each label In Array("Cohen Entities AI Accounting", "LJC Accounting")
    WriteUrl desktop & "\" & label & ".url", urlBody
    If oFSO.FolderExists(taskbar) Then
        WriteUrl taskbar & "\" & label & ".url", urlBody
    End If
Next

MsgBox "Shortcuts updated." & vbCrLf & vbCrLf & _
       "Desktop icons now open:" & vbCrLf & APP_URL & vbCrLf & vbCrLf & _
       "If the taskbar still opens the old app, unpin it and pin the new desktop icon.", _
       vbInformation, "Cohen Entities AI Accounting"

Sub WriteUrl(path, body)
    Dim f
    Set f = oFSO.CreateTextFile(path, True)
    f.Write body
    f.Close
End Sub
