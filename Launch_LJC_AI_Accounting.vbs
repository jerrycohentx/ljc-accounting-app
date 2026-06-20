' LJC AI Accounting — silent launcher (no command window)
Option Explicit
Dim oShell, oFSO, sFolder, sPort, sUrl, sLog, i, st, body

Set oShell = CreateObject("WScript.Shell")
Set oFSO = CreateObject("Scripting.FileSystemObject")
sFolder = oFSO.GetParentFolderName(WScript.ScriptFullName)
sPort = "3000"
sUrl = "http://localhost:" & sPort
sLog = oFSO.BuildPath(sFolder, "logs\server.log")

oShell.CurrentDirectory = sFolder
If Not oFSO.FolderExists(oFSO.BuildPath(sFolder, "logs")) Then
    oFSO.CreateFolder oFSO.BuildPath(sFolder, "logs")
End If

' Node required
If oShell.Run("cmd /c node -v >nul 2>&1", 0, True) <> 0 Then
    MsgBox "Node.js is not installed." & vbCrLf & vbCrLf & _
           "Install from https://nodejs.org then try again.", vbCritical, "LJC AI Accounting"
    WScript.Quit 1
End If

' Brief status (same pattern as LJC Loan Tracker)
On Error Resume Next
oShell.Run "mshta javascript:var s=new ActiveXObject('WScript.Shell');s.Popup('Starting LJC AI Accounting…',2,'LJC AI Accounting',64);close()", 0, False
On Error GoTo 0

' Build / deps if needed (hidden)
If Not oFSO.FileExists(oFSO.BuildPath(sFolder, "frontend\dist\index.html")) _
   Or Not oFSO.FolderExists(oFSO.BuildPath(sFolder, "node_modules")) Then
    oShell.Run "cmd /c """ & sFolder & "\_setup-if-needed.bat""", 0, True
End If

' Already running?
If HealthOk(sUrl) Then
    oShell.Run sUrl, 1, False
    WScript.Quit 0
End If

' Free port 3000 if something else is listening
If PortListening(sPort) Then
    KillPortListeners sPort
    WScript.Sleep 800
End If

' Start server hidden — log to logs\server.log
Dim runCmd
runCmd = "set NODE_ENV=production&& node """ & oFSO.BuildPath(sFolder, "server.js") & _
         """ >> """ & sLog & """ 2>&1"
oShell.Run "cmd /c " & runCmd, 0, False

For i = 1 To 45
    WScript.Sleep 400
    If HealthOk(sUrl) Then
        oShell.Run sUrl, 1, False
        WScript.Quit 0
    End If
Next

MsgBox "The accounting server did not start in time." & vbCrLf & vbCrLf & _
       "For errors, open START-APP-Visible.bat" & vbCrLf & _
       "Log: " & sLog, vbCritical, "LJC AI Accounting"
WScript.Quit 1

Function CreateHttp()
    Dim oHTTP
    Set CreateHttp = Nothing
    On Error Resume Next
    Set oHTTP = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    If oHTTP Is Nothing Then Set oHTTP = CreateObject("MSXML2.XMLHTTP")
    Set CreateHttp = oHTTP
    Err.Clear
    On Error GoTo 0
End Function

Function HealthOk(baseUrl)
    Dim oHTTP, st
    HealthOk = False
    Set oHTTP = CreateHttp()
    If oHTTP Is Nothing Then Exit Function
    On Error Resume Next
    oHTTP.Open "GET", baseUrl & "/health", False
    oHTTP.setTimeouts 1500, 1500, 2000, 3000
    oHTTP.Send
    st = oHTTP.Status
    If Err.Number = 0 And st = 200 Then HealthOk = True
    Err.Clear
    On Error GoTo 0
End Function

Function PortListening(port)
    Dim oExec, out, t0
    PortListening = False
    On Error Resume Next
    Set oExec = oShell.Exec("cmd /c netstat -ano | findstr /C:"":"" & CStr(port) & "" " & " | findstr LISTENING")
    If oExec Is Nothing Then Exit Function
    t0 = Timer
    Do While oExec.Status = 0
        WScript.Sleep 80
        If Timer - t0 > 3 Then Exit Do
    Loop
    out = oExec.StdOut.ReadAll
    PortListening = (InStr(1, out, "LISTENING", vbTextCompare) > 0)
    Err.Clear
    On Error GoTo 0
End Function

Sub KillPortListeners(port)
    On Error Resume Next
    oShell.Run "cmd /c for /f ""tokens=5"" %a in ('netstat -ano ^| findstr /C:"":"" & CStr(port) & "" ^| findstr LISTENING') do taskkill /F /PID %a 2>nul", 0, True
    WScript.Sleep 400
    Err.Clear
    On Error GoTo 0
End Sub
