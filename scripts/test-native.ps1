$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testOutput = Join-Path $projectRoot '.build\native-tests.exe'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:exe /utf8output /codepage:65001 "/out:$testOutput" /reference:System.dll /reference:System.Core.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll (Join-Path $projectRoot 'tests\NativeTests.cs') (Join-Path $projectRoot 'tests\IntegrationTests.cs') (Join-Path $projectRoot 'native\FileStore.cs') (Join-Path $projectRoot 'native\SystemIntegration.cs') (Join-Path $projectRoot 'native\SingleInstance.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native tests compilation failed' }
& $testOutput (Join-Path $projectRoot '.build\native-test-data')
if ($LASTEXITCODE -ne 0) { throw 'Native tests failed' }
