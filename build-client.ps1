param([switch]$FetchDependencies)
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$vswhere='C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$vs=& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if(!$vs){throw '需要 Visual Studio C++ desktop workload。'}
$cmake=Join-Path $vs 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
if(!(Test-Path -LiteralPath $cmake)){$cmake=(Get-Command cmake.exe -ErrorAction Stop).Source}
function Run-CMake([string[]]$Arguments){& $cmake @Arguments;if($LASTEXITCODE -ne 0){throw "CMake failed: $LASTEXITCODE"}}
if($FetchDependencies){
    foreach($dep in @(@('libdatachannel','https://github.com/paullouisageneau/libdatachannel.git','v0.24.5'),
        @('mbedtls','https://github.com/Mbed-TLS/mbedtls.git','mbedtls-3.6.7'),
        @('opus','https://github.com/xiph/opus.git','v1.5.2'))){
        $path=Join-Path $root "out\deps\$($dep[0])"
        if(!(Test-Path -LiteralPath $path)){& git clone --depth 1 --branch $dep[2] --recurse-submodules --shallow-submodules $dep[1] $path;if($LASTEXITCODE -ne 0){throw 'Dependency download failed'}}
    }
}
foreach($dep in @('libdatachannel','mbedtls','opus')){if(!(Test-Path -LiteralPath (Join-Path $root "out\deps\$dep\CMakeLists.txt"))){throw '先執行 build-client.ps1 -FetchDependencies。'}}
$prefix=Join-Path $root 'out\deps\install'
$tlsConfig=Join-Path $root 'out\deps\mbedtls\include\mbedtls\mbedtls_config.h'
$tlsText=[IO.File]::ReadAllText($tlsConfig)
$tlsText=$tlsText.Replace('//#define MBEDTLS_SSL_DTLS_SRTP','#define MBEDTLS_SSL_DTLS_SRTP')
[IO.File]::WriteAllText($tlsConfig,$tlsText,[Text.UTF8Encoding]::new($false))
$tlsBuild=Join-Path $root 'out\deps\mbedtls-build'
Run-CMake @('-S',(Join-Path $root 'out\deps\mbedtls'),'-B',$tlsBuild,'-A','x64','-DENABLE_PROGRAMS=OFF','-DENABLE_TESTING=OFF',"-DCMAKE_INSTALL_PREFIX=$prefix")
Run-CMake @('--build',$tlsBuild,'--config','Release','--parallel','4')
Run-CMake @('--install',$tlsBuild,'--config','Release')
$build=Join-Path $root 'out\client-build'
Run-CMake @('-S',(Join-Path $root 'pc'),'-B',$build,'-A','x64',"-DCMAKE_PREFIX_PATH=$prefix")
Run-CMake @('--build',$build,'--config','Release','--target','remote_desk_client','--parallel','4')
Write-Output (Join-Path $root 'out\remote_desk_client.exe')
