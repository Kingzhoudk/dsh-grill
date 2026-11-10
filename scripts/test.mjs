#!/usr/bin/env node
/**
 * Reproducible integration runner for the 拷问 (Grill) bundle.
 *
 * The two scripts under `tests/` are integration programs, not `node:test`
 * suites: they import real Harness internals (`@deepseek-ai/dsh-*`) and the
 * agent-loop mock adapter, so they must run with a DSH source checkout on the
 * module-resolution path. This runner copies them into a temporary directory
 * INSIDE that checkout (so Node walks up to the checkout's `node_modules`),
 * runs them with `tsx`, and removes the directory afterwards.
 *
 * Usage:
 *   node scripts/test.mjs              # from this package
 *   npm test                           # same, via package.json
 *   DSH_CHECKOUT=/path/to/checkout node scripts/test.mjs
 *
 * Environment:
 *   DSH_CHECKOUT      DSH source checkout (required)
 *   DSH_GRILL_PLUGIN  plugin directory the tests load (default: this package)
 *
 * Exit status is non-zero when a prerequisite is missing or any script fails.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)))
const checkout = process.env.DSH_CHECKOUT
const tests = ['host-integration.mts', 'client-integration.mts']

/** Print a failure and exit non-zero. */
function fail(message) {
  console.error(`grill-test: ${message}`)
  process.exit(1)
}

if (checkout === undefined || !existsSync(join(checkout, 'package.json'))) {
  fail('set DSH_CHECKOUT to a deepseek-harness source checkout')
}
const prerequisites = [
  ['tsx', join(checkout, 'node_modules', 'tsx')],
  ['jsdom', join(checkout, 'node_modules', 'jsdom')],
  ['@testing-library/react', join(checkout, 'node_modules', '@testing-library', 'react')],
]
const missing = prerequisites.filter(([, path]) => !existsSync(path)).map(([name]) => name)
if (missing.length > 0) {
  fail(`the checkout at "${checkout}" is missing ${missing.join(', ')} — run its package manager install first`)
}
for (const file of tests) {
  if (!existsSync(join(pluginDir, 'tests', file))) fail(`missing test script tests/${file}`)
}

// Inside the checkout, never in the OS temp dir: ESM resolution for the test
// imports must find the checkout's node_modules.
const scratch = mkdtempSync(join(checkout, '.grill-test-'))
const env = {
  ...process.env,
  DSH_CHECKOUT: checkout,
  DSH_GRILL_PLUGIN: pluginDir,
}
let failed = 0
try {
  for (const file of tests) {
    copyFileSync(join(pluginDir, 'tests', file), join(scratch, file))
  }
  for (const file of tests) {
    console.log(`grill-test: ${file}`)
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', join(scratch, file)], {
      cwd: checkout,
      env,
      stdio: 'inherit',
    })
    if (result.error !== undefined) fail(`could not start ${file}: ${result.error.message}`)
    if (result.status !== 0) {
      failed += 1
      console.error(`grill-test: ${file} failed with status ${String(result.status)}`)
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`grill-test: ${failed} of ${tests.length} script(s) failed`)
  process.exit(1)
}
console.log(`grill-test: all ${tests.length} script(s) passed`)
