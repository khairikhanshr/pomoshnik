// Windows script verification without Windows: PowerShell 7 (set PWSH_PATH to its binary) parses
// every generated script, compiles every Add-Type C# snippet (DllImport compiles anywhere; calls
// would only work on Windows), checks C# 5 syntax (Windows PowerShell 5.1 uses the legacy
// compiler) and runs the portable parts of the prelude end to end.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { run } from '../../src/main/tools/exec'
import { WINDOWS_CSHARP } from '../../src/main/tools/win/native'
import { buildPsScript, encodeArgs, encodePowerShell, parsePsOutput, powershellArgv } from '../../src/main/tools/win/ps'
import { WINDOWS_MEDIA_KEYS_CSHARP, WINDOWS_SCRIPTS } from '../../src/main/tools/win/scripts'

const PWSH = process.env.PWSH_PATH

const CHECKER = String.raw`
param([string]$Dir)
$ErrorActionPreference = 'Stop'
$parse = [ordered]@{}
foreach ($f in Get-ChildItem -LiteralPath $Dir -Filter *.ps1) {
  $tokens = $null
  $errors = $null
  $src = Get-Content -Raw -LiteralPath $f.FullName
  [void][System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$tokens, [ref]$errors)
  $parse[$f.BaseName] = @($errors | ForEach-Object { $_.Message + ' (line ' + $_.Extent.StartLineNumber + ')' })
}
# Roslyn reports language-version errors while binding, so C# 5 needs a full compilation.
$csharp = [ordered]@{}
$opts = [Microsoft.CodeAnalysis.CSharp.CSharpParseOptions]::new([Microsoft.CodeAnalysis.CSharp.LanguageVersion]::CSharp5)
$compileOpts = [Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions]::new([Microsoft.CodeAnalysis.OutputKind]::DynamicallyLinkedLibrary)
$refs = [System.Collections.Generic.List[Microsoft.CodeAnalysis.MetadataReference]]::new()
foreach ($asm in [AppDomain]::CurrentDomain.GetAssemblies()) {
  if (-not $asm.IsDynamic -and $asm.Location) { $refs.Add([Microsoft.CodeAnalysis.MetadataReference]::CreateFromFile($asm.Location)) }
}
foreach ($f in Get-ChildItem -LiteralPath $Dir -Filter *.cs) {
  $src = Get-Content -Raw -LiteralPath $f.FullName
  $problems = @()
  $tree = [Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText($src, $opts)
  $comp = [Microsoft.CodeAnalysis.CSharp.CSharpCompilation]::Create('JarvisCheck', [Microsoft.CodeAnalysis.SyntaxTree[]]@($tree), $refs, $compileOpts)
  $problems += @($comp.GetDiagnostics() | Where-Object { $_.Severity -eq [Microsoft.CodeAnalysis.DiagnosticSeverity]::Error } | ForEach-Object { 'C# 5: ' + $_.ToString() })
  try { Add-Type -TypeDefinition $src -ErrorAction Stop } catch { $problems += ('compile: ' + $_.Exception.Message) }
  $csharp[$f.BaseName] = $problems
}
ConvertTo-Json -InputObject @{ parse = $parse; csharp = $csharp } -Depth 5 -Compress
`

interface CheckResult {
  parse: Record<string, string[]>
  csharp: Record<string, string[]>
}

async function runScript(body: string, args: unknown): Promise<{ stdout: string; parsed: ReturnType<typeof parsePsOutput> }> {
  const argv = powershellArgv(encodePowerShell(buildPsScript(body)))
  const result = await run(PWSH as string, argv, { env: { JARVIS_ARGS: encodeArgs(args) }, timeoutMs: 60_000 })
  return { stdout: result.stdout, parsed: parsePsOutput(result.stdout) }
}

describe.runIf(Boolean(PWSH))('Windows PowerShell scripts (checked with PowerShell 7)', () => {
  let dir = ''
  let check: CheckResult

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'jarvis-pwsh-'))
    for (const [name, body] of Object.entries(WINDOWS_SCRIPTS)) writeFileSync(join(dir, `${name}.ps1`), buildPsScript(body), 'utf8')
    for (const [name, src] of Object.entries({ ...WINDOWS_CSHARP, mediaKeys: WINDOWS_MEDIA_KEYS_CSHARP })) {
      writeFileSync(join(dir, `${name}.cs`), src, 'utf8')
    }
    // Negative controls: the checks must reject these, or the suite proves nothing.
    writeFileSync(join(dir, 'zzBroken.ps1'), 'if ($x { Write-Output 1 }', 'utf8')
    writeFileSync(join(dir, 'zzCSharp6.cs'), 'public static class JarvisNeg { public static int P => 1; public static string S() { return $"a{1}"; } }', 'utf8')
    // A separate folder, so the checker is not itself one of the *.ps1 files under test.
    const checkerDir = mkdtempSync(join(tmpdir(), 'jarvis-pwsh-checker-'))
    const checkerPath = join(checkerDir, 'checker.ps1')
    writeFileSync(checkerPath, CHECKER, 'utf8')
    const out = execFileSync(PWSH as string, ['-NoProfile', '-NonInteractive', '-File', checkerPath, '-Dir', dir], {
      encoding: 'utf8',
      timeout: 120_000
    })
    rmSync(checkerDir, { recursive: true, force: true })
    check = JSON.parse(out) as CheckResult
  }, 180_000)

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  for (const name of Object.keys(WINDOWS_SCRIPTS)) {
    it(`parses ${name} without errors`, () => {
      expect(check.parse[name], name).toEqual([])
    })
  }

  for (const name of [...Object.keys(WINDOWS_CSHARP), 'mediaKeys']) {
    it(`compiles the ${name} C# snippet (C# 5 syntax)`, () => {
      expect(check.csharp[name], name).toEqual([])
    })
  }

  it('detects broken PowerShell and C# 6+ syntax (negative controls)', () => {
    expect(check.parse.zzBroken.length).toBeGreaterThan(0)
    expect(check.csharp.zzCSharp6.join('\n')).toMatch(/CS8026/)
  })

  it('passes Unicode arguments through JARVIS_ARGS and returns ASCII-only JSON', async () => {
    const args = { text: 'привет "мир" 😀 <&> \\ $(rm) `x`', n: 5, list: [1] }
    const { stdout, parsed } = await runScript('Send-Result @{ echo = [string]$A.text; n = [int]$A.n; list = @($A.list) }', args)
    expect(/^[\x00-\x7F]*$/.test(stdout)).toBe(true)
    expect(parsed).toEqual({ kind: 'result', value: { echo: args.text, n: 5, list: [1] } })
  }, 60_000)

  it('reports thrown errors through the error marker', async () => {
    const { parsed } = await runScript("throw 'Ошибка теста'", {})
    expect(parsed).toEqual({ kind: 'error', message: 'Ошибка теста' })
  }, 60_000)

  it('runs the portable scripts', async () => {
    expect((await runScript(WINDOWS_SCRIPTS.startApps, {})).parsed).toEqual({ kind: 'result', value: [] })
    expect((await runScript(WINDOWS_SCRIPTS.defaultBrowser, {})).parsed).toEqual({ kind: 'result', value: { progId: null, exe: null } })
    expect((await runScript(WINDOWS_SCRIPTS.close, { ids: [], force: false })).parsed).toEqual({
      kind: 'result',
      value: { requested: 0, alive: [] }
    })
  }, 60_000)

  it('runs user commands via Invoke-Expression with output and exit codes', async () => {
    const hello = await runScript(WINDOWS_SCRIPTS.runCommand, { command: 'Write-Output "привет"' })
    expect(hello.parsed.kind).toBe('result')
    const value = (hello.parsed as { value: { output: string; code: number } }).value
    expect(value.output.trim()).toBe('привет')
    expect(value.code).toBe(0)
    if (process.platform !== 'win32') {
      const failing = await runScript(WINDOWS_SCRIPTS.runCommand, { command: "/bin/sh -c 'echo out; exit 3'" })
      expect((failing.parsed as { value: { output: string; code: number } }).value).toMatchObject({ code: 3 })
    }
  }, 60_000)
})
