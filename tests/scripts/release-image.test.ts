import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let temporaryDirectory: string | undefined;

afterEach(() => {
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { force: true, recursive: true });
    temporaryDirectory = undefined;
  }
});

/**
 * Runs the script with a fake `gh` and a fake `git` first on PATH. The fake
 * `gh` prints `runLine` (what `gh run list ... --jq` would print for the newest
 * run) and records its arguments; the fake `git` reports `head` as the
 * checkout's HEAD, so a test controls which commit the deploy would run from.
 */
function runWithNewestRun(runLine: string, head: string = SHA) {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'clip-release-image-'));
  const argsFile = join(temporaryDirectory, 'gh-args');
  const fakeGh = join(temporaryDirectory, 'gh');
  writeFileSync(fakeGh, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nprintf '%s' '${runLine}'\n`);
  chmodSync(fakeGh, 0o755);
  const fakeGit = join(temporaryDirectory, 'git');
  writeFileSync(fakeGit, `#!/bin/sh\nprintf '%s\\n' '${head}'\n`);
  chmodSync(fakeGit, 0o755);
  const result = spawnSync('scripts/release-image.sh', [], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${temporaryDirectory}:${process.env.PATH}` },
  });
  return { ...result, ghArgs: readFileSync(argsFile, 'utf8').split('\n') };
}

const SHA = '6f086c0a1b2c3d4e5f60718293a4b5c6d7e8f901';
const OTHER_SHA = '19edede0000000000000000000000000000000ab';

describe('release-image', () => {
  it('prints the sha-<7> image of the newest release run when it succeeded', () => {
    const result = runWithNewestRun(`completed|success|${SHA}`);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('ghcr.io/cgm-16/clip:sha-6f086c0\n');
  });

  it('asks only for release runs from a push to main, newest first', () => {
    const { ghArgs } = runWithNewestRun(`completed|success|${SHA}`);

    expect(ghArgs).toEqual(expect.arrayContaining(['--workflow', 'release', '--branch', 'main', '--event', 'push']));
    expect(ghArgs[ghArgs.indexOf('--limit') + 1]).toBe('1');
  });

  it.each([
    ['still running', `in_progress||${SHA}`],
    ['failed', `completed|failure|${SHA}`],
    ['cancelled', `completed|cancelled|${SHA}`],
  ])('refuses, printing nothing, when the newest release run %s', (_label, runLine) => {
    const result = runWithNewestRun(runLine);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('(commit 6f086c0)');
  });

  it('refuses when there is no release run at all', () => {
    const result = runWithNewestRun('');

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  });
  // kubectl applies the manifests in the current checkout, so a deploy run
  // from another commit would pair the new image with old manifests.
  it('refuses when the checkout is not at the release commit, naming the checkout to make', () => {
    const result = runWithNewestRun(`completed|success|${SHA}`, OTHER_SHA);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`git checkout --detach ${SHA}`);
  });
});
