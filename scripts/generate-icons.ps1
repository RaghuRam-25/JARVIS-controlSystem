# PowerShell script to generate high-quality JARVIS icons for Web, Desktop (ICO/PNG), and Android (Mipmaps)
Add-Type -AssemblyName System.Drawing

function Generate-JarvisIcon([int]$size, [string]$outputPath, [bool]$isIco = $false) {
    $dir = Split-Path -Parent $outputPath
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }

    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    # Background
    $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 7, 10, 19))
    $g.FillRectangle($bgBrush, 0, 0, $size, $size)

    # Outer Arc Reactor Ring
    $outerPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(180, 0, 229, 255), [Math]::Max(2, $size * 0.04))
    $margin = $size * 0.1
    $g.DrawEllipse($outerPen, $margin, $margin, $size - 2 * $margin, $size - 2 * $margin)

    # Glowing Middle Ring
    $midPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 41, 121, 255), [Math]::Max(1.5, $size * 0.025))
    $midMargin = $size * 0.22
    $g.DrawEllipse($midPen, $midMargin, $midMargin, $size - 2 * $midMargin, $size - 2 * $midMargin)

    # Inner Core
    $coreBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0, 229, 255))
    $coreMargin = $size * 0.38
    $g.FillEllipse($coreBrush, $coreMargin, $coreMargin, $size - 2 * $coreMargin, $size - 2 * $coreMargin)

    # Center Pulse
    $centerBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
    $centerMargin = $size * 0.44
    $g.FillEllipse($centerBrush, $centerMargin, $centerMargin, $size - 2 * $centerMargin, $size - 2 * $centerMargin)

    # Clean up graphics
    $g.Dispose()

    if ($isIco) {
        $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
        $fs = New-Object System.IO.FileStream($outputPath, [System.IO.FileMode]::Create)
        $icon.Save($fs)
        $fs.Close()
        $icon.Dispose()
    } else {
        $bmp.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    }

    $bmp.Dispose()
    Write-Host "Generated: $outputPath ($size x $size)"
}

# 1. Web Public Icons
Generate-JarvisIcon 192 "packages/web/public/icon-192.png" $false
Generate-JarvisIcon 512 "packages/web/public/icon-512.png" $false

# 2. Desktop Electron Assets
Generate-JarvisIcon 512 "packages/desktop/assets/icon.png" $false
Generate-JarvisIcon 256 "packages/desktop/assets/icon.ico" $true

# 3. Android Mipmap Icons
$androidRes = "packages/android/app/src/main/res"
Generate-JarvisIcon 48  "$androidRes/mipmap-mdpi/ic_launcher.png" $false
Generate-JarvisIcon 72  "$androidRes/mipmap-hdpi/ic_launcher.png" $false
Generate-JarvisIcon 96  "$androidRes/mipmap-xhdpi/ic_launcher.png" $false
Generate-JarvisIcon 144 "$androidRes/mipmap-xxhdpi/ic_launcher.png" $false
Generate-JarvisIcon 192 "$androidRes/mipmap-xxxhdpi/ic_launcher.png" $false

Write-Host "All JARVIS icons successfully generated."
