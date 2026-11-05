if (-not $env:NODE_OPTIONS) { $env:NODE_OPTIONS = "--max-old-space-size=48" }
node "$PSScriptRoot\src\index.js" @args
