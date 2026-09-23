$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeRoot = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies'
$python = Join-Path $runtimeRoot 'python\python.exe'
$nodeModulesTarget = Join-Path $runtimeRoot 'node\node_modules'
$nodeModulesLink = Join-Path $projectRoot 'node_modules'

if (-not (Test-Path -LiteralPath $python)) {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pythonCommand) {
        throw 'Python was not found. Install Python 3 and openpyxl, then try again.'
    }
    $python = $pythonCommand.Source
}

if (-not (Test-Path -LiteralPath (Join-Path $nodeModulesLink 'playwright'))) {
    if (-not (Test-Path -LiteralPath $nodeModulesTarget)) {
        throw 'Playwright runtime dependencies were not found. Run this tool in Codex or install playwright locally.'
    }
    if (Test-Path -LiteralPath $nodeModulesLink) {
        $item = Get-Item -LiteralPath $nodeModulesLink -Force
        if ($item.LinkType -ne 'Junction') {
            throw "node_modules already exists and is not a runtime junction: $nodeModulesLink"
        }
        Remove-Item -LiteralPath $nodeModulesLink -Force
    }
    New-Item -ItemType Junction -Path $nodeModulesLink -Target $nodeModulesTarget | Out-Null
}

Set-Location -LiteralPath $projectRoot
& $python -u (Join-Path $projectRoot 'amazon_rank_tool.py')
