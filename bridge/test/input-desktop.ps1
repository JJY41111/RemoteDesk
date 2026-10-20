param([string]$Helper=(Join-Path $PSScriptRoot '..\..\out\recovery-2026-10-15\remote_desk_input.exe'),
 [string]$HelperArguments='--display=0:0')
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class InputDesktopProbe {
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint id);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
}
'@
$original=New-Object InputDesktopProbe+Point
if(![InputDesktopProbe]::GetCursorPos([ref]$original)){throw 'Cannot read interactive cursor'}
$previousWindow=[InputDesktopProbe]::GetForegroundWindow()
$info=New-Object Diagnostics.ProcessStartInfo
$info.FileName=(Resolve-Path -LiteralPath $Helper).Path
$info.Arguments=$HelperArguments
$info.UseShellExecute=$false;$info.CreateNoWindow=$true
$info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
$helperProcess=[Diagnostics.Process]::Start($info)
try {
 $ready=$helperProcess.StandardOutput.ReadLineAsync()
 if(!$ready.Wait(5000) -or $ready.Result -ne 'READY'){throw 'Input helper did not become ready'}
 $desk=@(Get-Process -Name DeskIn -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
 $targets=@([pscustomobject]@{Name='original-foreground';Window=$previousWindow})
 if($desk.Count){$targets+= [pscustomobject]@{Name='DeskIn-foreground';Window=$desk[0].MainWindowHandle}}
 $results=@()
 foreach($target in $targets){
  [void][InputDesktopProbe]::SetForegroundWindow($target.Window)
  Start-Sleep -Milliseconds 200
  $foreground=[InputDesktopProbe]::GetForegroundWindow()
  [uint32]$foregroundId=0
  [void][InputDesktopProbe]::GetWindowThreadProcessId($foreground,[ref]$foregroundId)
  if($target.Name -eq 'DeskIn-foreground' -and $foreground -ne $target.Window){throw 'Could not focus DeskIn; do not claim DeskIn foreground acceptance'}
  $before=New-Object InputDesktopProbe+Point
  [void][InputDesktopProbe]::GetCursorPos([ref]$before)
  $dx=if($before.X -gt ([InputDesktopProbe]::GetSystemMetrics(0)-80)){-24}else{24}
  $helperProcess.StandardInput.WriteLine("D $dx 0")
  $helperProcess.StandardInput.Flush()
  Start-Sleep -Milliseconds 200
  $after=New-Object InputDesktopProbe+Point
  [void][InputDesktopProbe]::GetCursorPos([ref]$after)
  $moved=($after.X -ne $before.X -or $after.Y -ne $before.Y)
  $results+=[pscustomobject]@{Case=$target.Name;ForegroundProcess=(Get-Process -Id $foregroundId).ProcessName;CursorMoved=$moved;DeltaX=($after.X-$before.X);DeltaY=($after.Y-$before.Y)}
 }
 $results | ConvertTo-Json
 if(@($results | Where-Object { !$_.CursorMoved }).Count){throw 'Real cursor did not move; inspect helper diagnostics'}
 Write-Output 'PASS: real helper mouse movement; no clicks, keys, UAC, or external remote session tested.'
} finally {
 $helperProcess.StandardInput.Close()
 if(!$helperProcess.WaitForExit(3000)){$helperProcess.Kill();$helperProcess.WaitForExit()}
 Write-Output ('Helper stderr: '+$helperProcess.StandardError.ReadToEnd())
 Write-Output ('Helper stdout: '+$helperProcess.StandardOutput.ReadToEnd())
 $helperProcess.Dispose()
 [void][InputDesktopProbe]::SetCursorPos($original.X,$original.Y)
 [void][InputDesktopProbe]::SetForegroundWindow($previousWindow)
}
