' Install / replace desktop + taskbar shortcuts → cloud app (one-time or after updates)
Option Explicit

Const APP_NAME = "LJC Accounting"
Const APP_URL = "https://ljc-accounting-app.onrender.com"

Dim oShell, oFSO, desktop, taskbar, urlBody, names, n, p

Set oShell = CreateObject("WScript.Shell")
Set oFSO = CreateObject("Scripting.FileSystemObject")

desktop = oShell.SpecialFolders("Desktop")
taskbar = oShell.ExpandEnvironmentStrings("%APPDATA%") & "\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"

urlBody = "[InternetShortcut]" & vbCrLf & _
          "URL=" & APP_URL & vbCrLf & _
          "IconIndex=0" & vbCrLf

' Remove old local shortcuts (common names from prior installs)
names = Array( _
    "LJC AI Accounting.lnk", _
    "LJC Accounting.lnk", _
    "LJC AI Accounting.url", _
    "LJC Accounting.url" _
)
For Each n In names
    p = desktop & "\" & n
    If oFSO.FileExists(p) Then oFSO.DeleteFile p, True
    p = taskbar & "\" & n
    If oFSO.FileExists(p) Then oFSO.DeleteFile p, True
Next

WriteUrl desktop & "\" & APP_NAME & ".url", urlBody

If oFSO.FolderExists(taskbar) Then
    WriteUrl taskbar & "\" & APP_NAME & ".url", urlBody
End If

MsgBox APP_NAME & " shortcuts updated." & vbCrLf & vbCrLf & _
       "Desktop and taskbar now open:" & vbCrLf & APP_URL & vbCrLf & vbCrLf & _
       "If the taskbar icon did not change, unpin the old one and pin the new desktop icon.", _
       vbInformation, APP_NAME

Sub WriteUrl(path, body)
    Dim f
    Set f = oFSO.CreateTextFile(path, True)
    f.Write body
    f.Close
End Sub
