' Script VBS untuk menjalankan Antigravity Mobile Bridge di background 24/7 tanpa jendela terminal
' Memastikan server tetap aktif bahkan ketika Antigravity IDE di-close atau laptop direstart
Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
scriptDir = FSO.GetParentFolderName(WScript.ScriptFullName)

batPath = scriptDir & "\run_background.bat"

If FSO.FileExists(batPath) Then
    WshShell.CurrentDirectory = scriptDir
    WshShell.Run "cmd.exe /d /s /c " & Chr(34) & Chr(34) & batPath & Chr(34) & " /background" & Chr(34), 0, False
End If

Set WshShell = Nothing
Set FSO = Nothing
