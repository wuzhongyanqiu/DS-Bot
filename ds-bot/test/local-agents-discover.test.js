import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { cleanEnv, findExecutable, probeVersion, refreshSearchDirs } from '../src/host/local-agents/discover.js'

// A slow npm on PATH stands for the real one: it takes seconds to start, and the
// host must not wait for it on the way to a Session.
test('finding a CLI never waits on npm, and npm\'s global folder joins in the background', { skip: process.platform === 'win32' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsb-discover-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fakeBin = join(root, 'bin')
  const prefix = join(root, 'npm-global')
  mkdirSync(fakeBin)
  mkdirSync(join(prefix, 'bin'), { recursive: true })
  writeFileSync(join(fakeBin, 'npm'), `#!/bin/sh\nsleep 2\nprintf '%s\\n' '${prefix}'\n`)
  writeFileSync(join(prefix, 'bin', 'dsb-fake-agent'), '#!/bin/sh\n')
  chmodSync(join(fakeBin, 'npm'), 0o755)
  chmodSync(join(prefix, 'bin', 'dsb-fake-agent'), 0o755)
  const { PATH, SHELL } = process.env
  process.env.PATH = `${fakeBin}${delimiter}${PATH}`
  process.env.SHELL = '/bin/false'
  t.after(() => { process.env.PATH = PATH; process.env.SHELL = SHELL })

  const started = Date.now()
  assert.equal(findExecutable('dsb-fake-agent'), undefined)
  const refresh = refreshSearchDirs()
  assert.ok(Date.now() - started < 1000, 'the lookup waited on npm')
  await refresh
  assert.equal(findExecutable('dsb-fake-agent'), join(prefix, 'bin', 'dsb-fake-agent'))
})

// A Dock launch gets a sparse PATH. A CLI installed by npm starts node through
// `env`, so the scan's folders must reach the child's PATH, and its version must
// still come back for the Settings page.
test('a sparse PATH still runs a CLI through node and reads its version', { skip: process.platform === 'win32' }, async (t) => {
  const { spawnSync } = await import('node:child_process')
  const { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'dsb-dock-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const loginBin = join(root, 'login-bin')
  const cliBin = join(root, 'npm-global', 'bin')
  mkdirSync(loginBin)
  mkdirSync(cliBin, { recursive: true })
  // The login shell knows where node lives; the CLI starts it with `env node`.
  writeFileSync(join(loginBin, 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`)
  const cli = join(cliBin, 'dsb-path-cli')
  writeFileSync(cli, '#!/usr/bin/env node\nconsole.log(process.argv.includes("--version") ? "9.9.9" : "cli-ok")\n')
  // A login shell that reports the folders the user's PATH really has.
  const shell = join(root, 'login-shell')
  writeFileSync(shell, `#!/bin/sh\nprintf '%s' '${loginBin}${delimiter}${cliBin}'\n`)
  for (const file of [join(loginBin, 'node'), cli, shell]) chmodSync(file, 0o755)

  const { PATH, SHELL } = process.env
  process.env.PATH = '/usr/bin:/bin'
  process.env.SHELL = shell
  t.after(() => { process.env.PATH = PATH; process.env.SHELL = SHELL })

  await refreshSearchDirs(true)
  assert.equal(findExecutable('dsb-path-cli'), cli)
  const env = cleanEnv()
  assert.ok(env.PATH.split(delimiter).includes(loginBin), 'the login folders join the child PATH')
  const ran = spawnSync(cli, [], { env, encoding: 'utf8' })
  assert.equal(ran.stdout.trim(), 'cli-ok', ran.stderr)
  const version = await probeVersion(cli, ['--version'], env)
  assert.equal(version.version, '9.9.9')
})
