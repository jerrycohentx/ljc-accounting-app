' LJC Accounting — opens the cloud app (no local server)
Option Explicit

Dim oShell, sUrl

sUrl = "https://ljc-accounting-app.onrender.com"
Set oShell = CreateObject("WScript.Shell")

On Error Resume Next
oShell.Run "mshta javascript:var s=new ActiveXObject('WScript.Shell');s.Popup('Opening LJC Accounting…',2,'LJC Accounting',64);close()", 0, False
On Error GoTo 0

oShell.Run sUrl, 1, False
