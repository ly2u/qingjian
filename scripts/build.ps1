param([switch]$SkipWeb, [switch]$NoZip, [string]$OutputDirectory = 'dist')
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
$output = [IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDirectory))
if (-not $output.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output must stay inside the project workspace.' }
$cache = Join-Path $projectRoot '.build'
New-Item -ItemType Directory -Force -Path $output, $cache | Out-Null
if (-not $SkipWeb) {
    $env:QINGJIAN_OUTPUT_DIR = $output
    & node (Join-Path $PSScriptRoot 'build.mjs')
    if ($LASTEXITCODE -ne 0) { throw '前端构建失败' }
}
$sdkVersion = '1.0.4314.35'
$webview = Join-Path $cache 'webview2'
if (-not (Test-Path -LiteralPath (Join-Path $webview 'lib\net462\Microsoft.Web.WebView2.Core.dll'))) {
    $archive = Join-Path $cache 'webview2.zip'
    Invoke-WebRequest -UseBasicParsing -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdkVersion/microsoft.web.webview2.$sdkVersion.nupkg" -OutFile $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $webview -Force
}
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object Drawing.Bitmap(128, 128)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$shape = New-Object Drawing.Drawing2D.GraphicsPath
$shape.AddArc(0, 0, 48, 48, 180, 90)
$shape.AddArc(79, 0, 48, 48, 270, 90)
$shape.AddArc(79, 79, 48, 48, 0, 90)
$shape.AddArc(0, 79, 48, 48, 90, 90)
$shape.CloseFigure()
$brush = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml('#336a57'))
$graphics.FillPath($brush, $shape)
$pen = New-Object Drawing.Pen([Drawing.ColorTranslator]::FromHtml('#fffdf8'), 7)
$pen.StartCap = [Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [Drawing.Drawing2D.LineJoin]::Round
$points = [Drawing.Point[]]@([Drawing.Point]::new(36,84), [Drawing.Point]::new(36,40), [Drawing.Point]::new(91,40), [Drawing.Point]::new(64,88), [Drawing.Point]::new(91,88))
$graphics.DrawLines($pen, $points)
$pen.Color = [Drawing.ColorTranslator]::FromHtml('#c9dca5')
$graphics.DrawLine($pen, 36, 84, 64, 62)
$icon = [Drawing.Icon]::FromHandle($bitmap.GetHicon())
$iconFile = Join-Path $cache 'qingjian.ico'
$iconStream = [IO.File]::Create($iconFile)
$icon.Save($iconStream)
$iconStream.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
$pen.Dispose()
$brush.Dispose()
$shape.Dispose()
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
$core = Join-Path $webview 'lib\net462\Microsoft.Web.WebView2.Core.dll'
$forms = Join-Path $webview 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'
$exe = Join-Path $output '轻笺.exe'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /utf8output /codepage:65001 "/out:$exe" "/win32icon:$iconFile" "/win32manifest:$(Join-Path $projectRoot 'native\app.manifest')" /reference:System.dll /reference:System.Core.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/reference:$core" "/reference:$forms" (Join-Path $projectRoot 'native\Program.cs') (Join-Path $projectRoot 'native\FileStore.cs') (Join-Path $projectRoot 'native\FileSynchronization.cs') (Join-Path $projectRoot 'native\SystemIntegration.cs') (Join-Path $projectRoot 'native\SingleInstance.cs')
if ($LASTEXITCODE -ne 0) { throw 'Windows 程序编译失败' }
Copy-Item -LiteralPath $core, $forms -Destination $output -Force
Copy-Item -LiteralPath (Join-Path $webview 'runtimes\win-x64\native\WebView2Loader.dll') -Destination $output -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'native\Qingjian.exe.config') -Destination (Join-Path $output '轻笺.exe.config') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot '使用说明.txt') -Destination $output -Force
if (Test-Path -LiteralPath (Join-Path $projectRoot 'LICENSE')) { Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE') -Destination $output -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $output 'examples') | Out-Null
Get-ChildItem -LiteralPath (Join-Path $projectRoot 'examples') -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $output 'examples') -Force }
$utf8 = New-Object Text.UTF8Encoding($false)
foreach ($entry in @(@('注册到打开方式.cmd', '--register'), @('移除系统注册.cmd', '--unregister'))) {
    $scriptText = "@echo off`r`nchcp 65001>nul`r`nstart `"`" `"%~dp0轻笺.exe`" $($entry[1])`r`n"
    [IO.File]::WriteAllText((Join-Path $output $entry[0]), $scriptText, $utf8)
}
Get-ChildItem -LiteralPath $webview -File | Where-Object { $_.Name -match '^(LICENSE|NOTICE)' } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $output ('WebView2-' + $_.Name)) -Force }
if (-not $NoZip) {
    $zip = Join-Path $projectRoot '轻笺-Windows-x64.zip'
    Compress-Archive -Path (Join-Path $output '*') -DestinationPath $zip -Force
    Write-Host ('压缩包：' + $zip)
}
$bytes = (Get-ChildItem -LiteralPath $output -File -Recurse | Measure-Object Length -Sum).Sum
Write-Host ('程序目录：' + $output)
Write-Host ('程序文件体积：' + [Math]::Round($bytes / 1MB, 2) + ' MiB（不含系统 WebView2 和个人数据）')
