import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('render-k8s-deployment', () => {
  it('renders the released image identically for migrate and app containers', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'clip-render-k8s-deployment-'));
    const output = join(temporaryDirectory, 'deployment.yaml');

    execFileSync('scripts/render-k8s-deployment.sh', ['ghcr.io/cgm-16/clip:sha-7139b60', output]);

    const manifest = readFileSync(output, 'utf8');
    expect([...manifest.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((match) => match[1])).toEqual([
      'ghcr.io/cgm-16/clip:sha-7139b60',
      'ghcr.io/cgm-16/clip:sha-7139b60',
    ]);
    expect(manifest).not.toContain('__CLIP_RELEASE_IMAGE__');
  });

  it.each([
    'ghcr.io/cgm-16/clip:latest',
    'ghcr.io/cgm-16/clip:sha-ABCDEF1',
    'ghcr.io/other/clip:sha-7139b60',
    'ghcr.io/cgm-16/clip:sha-123456',
  ])('rejects invalid image %s without creating output', (image) => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'clip-render-k8s-deployment-'));
    const output = join(temporaryDirectory, 'deployment.yaml');

    expect(() => execFileSync('scripts/render-k8s-deployment.sh', [image, output], { stdio: 'pipe' })).toThrow();
    expect(() => readFileSync(output, 'utf8')).toThrow();
  });

  it('preserves an existing output when the image is invalid', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'clip-render-k8s-deployment-'));
    const output = join(temporaryDirectory, 'deployment.yaml');
    writeFileSync(output, 'preserve-me');

    expect(() =>
      execFileSync('scripts/render-k8s-deployment.sh', ['ghcr.io/cgm-16/clip:latest', output], { stdio: 'pipe' }),
    ).toThrow();

    expect(readFileSync(output, 'utf8')).toBe('preserve-me');
  });
});
