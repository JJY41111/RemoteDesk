$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root=$PSScriptRoot
$app=Join-Path $root 'out\remote_desk_client.exe'
if(!(Test-Path -LiteralPath $app)){throw '先執行 build-client.ps1。'}
$vs=& 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe' -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$runtimeRoot=Join-Path $vs 'VC\Redist\MSVC'
$runtime=Get-ChildItem -LiteralPath $runtimeRoot -Directory | Where-Object {$_.Name -match '^\d+\.\d+\.\d+$'} | Sort-Object {[version]$_.Name} -Descending | Select-Object -First 1
$crt=Get-ChildItem -LiteralPath (Join-Path $runtime.FullName 'x64') -Directory | Where-Object Name -like 'Microsoft.VC*.CRT' | Select-Object -First 1
if(!$crt){throw '找不到可散佈的 Visual C++ x64 Runtime。'}
$items=@(@{Path=$app;Entry='remote_desk_client.exe'},
    @{Path=(Join-Path $root 'pc\README.md');Entry='README.md'},
    @{Path=(Join-Path $root 'docs\windows-client-2026-10-13.md');Entry='DEVELOPMENT.md'})
foreach($dll in Get-ChildItem -LiteralPath $crt.FullName -Filter '*.dll'){$items+=@{Path=$dll.FullName;Entry=$dll.Name}}
foreach($dep in @('libdatachannel','mbedtls','opus','libdatachannel\deps\json','libdatachannel\deps\libjuice','libdatachannel\deps\libsrtp','libdatachannel\deps\plog','libdatachannel\deps\usrsctp')){
    $directory=Join-Path $root "out\deps\$dep"
    foreach($license in Get-ChildItem -LiteralPath $directory -File -Force | Where-Object {$_.Name -match '^(LICENSE|COPYING)'}){
        $items+=@{Path=$license.FullName;Entry=('licenses/'+$dep.Replace('\','-')+'-'+$license.Name)}
    }
}
$licenseNote=Join-Path $root 'pc\THIRD-PARTY.md'
$items+=@{Path=$licenseNote;Entry='THIRD-PARTY.md'}
$path=Join-Path $root 'out\RemoteDesk-Windows-client.zip'
$stream=[IO.File]::Open($path,[IO.FileMode]::Create)
$zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create)
try{foreach($item in $items){[void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$item.Path,$item.Entry)}}finally{$zip.Dispose();$stream.Dispose()}
$verify=[IO.Compression.ZipFile]::OpenRead($path)
try{
    if(!($verify.Entries | Where-Object FullName -eq 'remote_desk_client.exe')){throw 'ZIP 缺少執行檔'}
    if($verify.Entries | Where-Object {$_.FullName -match 'private|settings\.json|ca-key|\.pem$|\.crt$|\.pdb$'}){throw 'ZIP 不應包含主機私有資料或憑證'}
    $verify.Entries | Select-Object FullName,Length
}finally{$verify.Dispose()}
Get-FileHash -LiteralPath $path -Algorithm SHA256
