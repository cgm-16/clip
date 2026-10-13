import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const SHA = '6f086c0a1b2c3d4e5f60718293a4b5c6d7e8f901';
const IMAGE = 'ghcr.io/cgm-16/clip:sha-6f086c0';

/**
 * Runs the script with fake `gh`, `git` and `kubectl` first on PATH. The fake
 * `gh` prints `runLine` for the newest release run and the fake `git` reports
 * the release commit as HEAD, as in release-image.test.ts. The fake `kubectl`
 * logs each call's arguments, keeps a copy of any file applied from outside
 * `k8s/` (the rendered deployment, deleted when the script exits), and prints
 * `deployedImage` for the image read-back.
 */
function deployWith(runLine: string, deployedImage: string = IMAGE) {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'clip-deploy-'));
  const kubectlLog = join(temporaryDirectory, 'kubectl-log');
  const renderedCopy = join(temporaryDirectory, 'rendered-copy');
  const stubs: Record<string, string> = {
    gh: `printf '%s' '${runLine}'`,
    git: `printf '%s\\n' '${SHA}'`,
    kubectl: [
      `printf '%s\\n' "$*" >> '${kubectlLog}'`,
      `case "$1 $3" in "apply k8s/"*) ;; "apply "*) cat "$3" > '${renderedCopy}' ;; esac`,
      `case "$3 $4" in "get deploy") printf '%s' '${deployedImage}' ;; esac`,
    ].join('\n'),
  };
  for (const [name, body] of Object.entries(stubs)) {
    const path = join(temporaryDirectory, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }
  const result = spawnSync('scripts/deploy.sh', [], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${temporaryDirectory}:${process.env.PATH}` },
  });
  const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
  return { ...result, kubectlCalls: read(kubectlLog).split('\n').filter(Boolean), rendered: read(renderedCopy) };
}

describe('deploy', () => {
  // The refusal must stop the script itself, not only the renderer's tag check
  // further on, so nothing after the release check runs.
  it('stops at the release check when the newest release run is not a success', () => {
    const result = deployWith(`in_progress||${SHA}`);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('newest release run on main is in_progress');
    expect(result.kubectlCalls).toEqual([]);
  });

  it('applies the manifests and the rendered release image, then waits for and checks the rollout', () => {
    const result = deployWith(`completed|success|${SHA}`);

    expect(result.status).toBe(0);
    expect(result.kubectlCalls).toEqual([
      'apply -f k8s/namespace.yaml',
      'apply -f k8s/postgres.yaml',
      'apply -f k8s/service.yaml',
      'apply -f k8s/ingress.yaml',
      expect.stringMatching(/^apply -f \/\S+$/),
      '-n clip rollout status deploy/clip --timeout=5m',
      `-n clip get deploy clip -o jsonpath={.spec.template.spec.containers[?(@.name=="clip")].image}`,
    ]);
    expect(result.rendered).toContain(`image: ${IMAGE}`);
    expect(result.stdout).toContain(IMAGE);
  });

  it('fails when the deployed image read back is not the released one', () => {
    const result = deployWith(`completed|success|${SHA}`, 'ghcr.io/cgm-16/clip:sha-19edede');

    expect(result.status).not.toBe(0);
    expect(result.kubectlCalls.at(-1)).toMatch(/^-n clip get deploy clip /);
    expect(result.stderr).toContain('ghcr.io/cgm-16/clip:sha-19edede');
  });
});
