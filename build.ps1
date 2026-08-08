[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $scriptDir 'build.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
