[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $repositoryRoot
try {
  $pkg = Get-Content -LiteralPath package.json -Raw -Encoding UTF8 | ConvertFrom-Json
  $commit = git rev-parse HEAD
  if ($LASTEXITCODE -ne 0) { throw 'Commit the source before packaging.' }
  $sourceTree = git rev-parse 'HEAD^{tree}'
  if ($LASTEXITCODE -ne 0) { throw 'Cannot identify source tree.' }
  $knowledgeTree = git rev-parse HEAD:scripts/conocimiento
  if ($LASTEXITCODE -ne 0) { throw 'Knowledge engine must be committed.' }
  $dirty = @(git status --porcelain --untracked-files=normal -- . ":!$($pkg.name)-$($pkg.version).vsix" ":!releases/$($pkg.version).json")
  if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw 'Source has uncommitted changes. Commit them before packaging.' }
  node scripts/verify-vendor.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Vendored knowledge verification failed.' }
  $vendor = Get-Content -LiteralPath vendor/conocimiento.json -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($knowledgeTree.Trim() -ne $vendor.sourceTree) { throw 'Committed knowledge tree differs from upstream.' }

  $output = "artifacts/$($pkg.name)-$($pkg.version).vsix"
  New-Item -ItemType Directory -Path artifacts -Force | Out-Null
  npm exec -- vsce package --no-dependencies --no-rewrite-relative-links --skip-license -o $output
  if ($LASTEXITCODE -ne 0) { throw 'VSIX packaging failed.' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $output))
  try {
    $entries = @($archive.Entries)
    $names = @($entries.FullName)
    if (($names | Sort-Object -Unique).Count -ne $names.Count) { throw 'Duplicate ZIP entries.' }
    $required = @('extension.vsixmanifest', '[Content_Types].xml', 'extension/package.json', 'extension/readme.md', 'extension/changelog.md', 'extension/dist/extension.cjs', 'extension/dist/THIRD-PARTY-NOTICES.txt', 'extension/media/view.js', 'extension/media/view.css', 'extension/media/theme-tokens.css', 'extension/media/reading-tokens.css', 'extension/media/icon.svg', 'extension/demo/openspec/config.yaml')
    foreach ($name in $required) {
      if ($names -cnotcontains $name -or $archive.GetEntry($name).Length -eq 0) { throw "Missing or empty entry: $name" }
    }
    $allowed = '^(extension\.vsixmanifest|\[Content_Types\]\.xml|extension/(package\.json|readme\.md|changelog\.md|media/(icon\.svg|theme-tokens\.css|reading-tokens\.css|view\.(css|js))|dist/(extension\.cjs|THIRD-PARTY-NOTICES\.txt)|(demo|docs)/[a-zA-Z0-9_./-]+\.(md|json|ya?ml)))$'
    $forbidden = '(^|/)(\.\.?|\.git|\.local|\.vscode|node_modules|src|tests|scripts|profiles?|credentials?)(/|$)|(^|/)\.env|^extension/docs/history/|\.(vsix|zip|map|woff2?|ttf|otf|pem|key|pfx)$'
    foreach ($name in $names) {
      if ($name -cnotmatch $allowed -or $name -match $forbidden) { throw "Unexpected packaged entry: $name" }
    }
    function Read-Entry([string]$name) {
      $reader = [IO.StreamReader]::new($archive.GetEntry($name).Open())
      try { $reader.ReadToEnd() } finally { $reader.Dispose() }
    }
    $packed = (Read-Entry 'extension/package.json') | ConvertFrom-Json
    $manifest = [xml](Read-Entry 'extension.vsixmanifest')
    $identity = $manifest.PackageManifest.Metadata.Identity
    if ($packed.publisher -ne 'fdelvalle01' -or $packed.name -ne 'openspec-viewer') { throw 'Unexpected personal extension identity.' }
    if ($packed.name -ne $pkg.name -or $packed.publisher -ne $pkg.publisher -or $packed.version -ne $pkg.version -or $packed.main -ne './dist/extension.cjs') { throw 'Packaged metadata differs from source.' }
    if ($packed.repository.url -ne 'https://github.com/fdelvalle01/sdd-openspec-view.git' -or $packed.repository.directory) { throw 'Unexpected source repository.' }
    if ($identity.Id -ne $pkg.name -or $identity.Publisher -ne $pkg.publisher -or $identity.Version -ne $pkg.version) { throw 'VSIX manifest identity differs from source.' }
    $contents = @($entries | Sort-Object FullName | ForEach-Object { @{ path = $_.FullName; bytes = $_.Length } })
  } finally { $archive.Dispose() }

  $headAfterBuild = git rev-parse HEAD
  if ($LASTEXITCODE -ne 0 -or $headAfterBuild.Trim() -ne $commit.Trim()) { throw 'Source commit changed while packaging.' }
  $dirtyAfterBuild = @(git status --porcelain --untracked-files=normal -- . ":!$($pkg.name)-$($pkg.version).vsix" ":!releases/$($pkg.version).json")
  if ($LASTEXITCODE -ne 0 -or $dirtyAfterBuild.Count -ne 0) { throw 'Source changed while packaging.' }

  $workflowRun = $null
  if ($env:GITHUB_RUN_ID) { $workflowRun = "$env:GITHUB_SERVER_URL/$env:GITHUB_REPOSITORY/actions/runs/$env:GITHUB_RUN_ID" }
  $record = [ordered]@{
    schemaVersion = 1
    repository = 'https://github.com/fdelvalle01/sdd-openspec-view'
    sourceCommit = $commit.Trim()
    sourceTree = $sourceTree.Trim()
    sourceDirectory = '.'
    knowledgeDirectory = 'scripts/conocimiento'
    knowledgeSourceTree = $knowledgeTree.Trim()
    knowledgeOrigin = $vendor
    extension = "$($pkg.publisher).$($pkg.name)@$($pkg.version)"
    package = @{ file = [IO.Path]::GetFileName($output); sha256 = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant(); bytes = (Get-Item -LiteralPath $output).Length }
    lockfileSha256 = (Get-FileHash -LiteralPath package-lock.json -Algorithm SHA256).Hash.ToLowerInvariant()
    nodeVersion = (node --version)
    workflowRun = $workflowRun
    contents = $contents
  }
  $manifestPath = Join-Path $repositoryRoot "artifacts/$($pkg.name)-$($pkg.version).manifest.json"
  [IO.File]::WriteAllText($manifestPath, ($record | ConvertTo-Json -Depth 10) + "`n", [Text.UTF8Encoding]::new($false))
  Write-Output "Inspected package: $output"
  Write-Output "Provenance: $manifestPath"
} finally { Pop-Location }
