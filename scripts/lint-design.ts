// `pnpm lint:design`: mechanical checks for the CLAUDE.md design rules that are
// easiest to break unnoticed — tokens.css as the only source of colours (rule 2),
// the 4px spacing scale (rule 2), --faint for disabled controls only (rule 3),
// and Korean copy living only in the string tables (rule 9). A grep-level
// scanner, not a parser: it blanks comments so that quoting approved copy or an
// issue number like #58 in a comment never counts.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Violation = { path: string; line: number; rule: string; excerpt: string };

const STRING_TABLES = new Set(['lib/ui/copy.ts', 'lib/discord/copy.ts']);
const SCANNED_ROOTS = ['app', 'lib', 'components'];
const SKIPPED_DIRS = new Set(['node_modules', 'generated']);

const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/g;
const PX = /(?<![\w.])(\d*\.?\d+)px\b/g;
const PX_EXCEPTIONS = new Set([1, 2, 13.5, 12.5, 11.5, 11, 10]);

/**
 * Returns two copies of a TS/TSX source the same length as the input, newlines
 * kept: `code` with comments blanked, and `literals` with everything except
 * string and template literal contents blanked.
 * ponytail: no regex-literal or `${}`-nesting awareness; a quote inside a regex
 * literal or a backtick inside `${}` can misplace a literal boundary.
 */
function maskScript(text: string): { code: string; literals: string } {
  const code = text.split('');
  const literals = text.replace(/[^\n]/g, ' ').split('');
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') code[i++] = ' ';
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i++) if (text[i] !== '\n') code[i] = ' ';
    } else if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < text.length && text[i] !== c && (c === '`' || text[i] !== '\n')) {
        if (text[i] === '\\') literals[i] = text[i++];
        if (i < text.length) literals[i] = text[i++];
      }
      i++;
    } else {
      i++;
    }
  }
  return { code: code.join(''), literals: literals.join('') };
}

function blankCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

export function findDesignViolations(path: string, text: string): Violation[] {
  const violations: Violation[] = [];
  const lines = text.split('\n');
  const report = (index: number, rule: string) => {
    const line = lineAt(text, index);
    // One report per line per rule: a Korean sentence is one violation, not one per syllable.
    if (violations.some((v) => v.line === line && v.rule === rule)) return;
    violations.push({ path, line, rule, excerpt: lines[line - 1].trim() });
  };
  const scan = (masked: string, pattern: RegExp, rule: string, keep: (m: RegExpMatchArray) => boolean = () => true) => {
    for (const m of masked.matchAll(pattern)) if (keep(m)) report(m.index!, rule);
  };

  if (path.endsWith('.css')) {
    const css = blankCssComments(text);
    if (path !== 'tokens.css') scan(css, HEX, 'hex-colour');
    scan(css, PX, 'px-scale', (m) => {
      const value = Number(m[1]);
      return value % 4 !== 0 && !PX_EXCEPTIONS.has(value);
    });
    // Innermost `selector { declarations }` pairs; an @media wrapper's own
    // brace is excluded by `[^{}]`, so its rules are seen with their selectors.
    for (const rule of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const selectors = rule[1].split(',');
      if (selectors.every((s) => s.includes(':disabled') || s.includes('[aria-disabled'))) continue;
      const bodyStart = rule.index! + rule[1].length + 1;
      for (const m of rule[2].matchAll(/var\(\s*--faint\s*\)/g)) report(bodyStart + m.index!, 'faint-not-disabled');
    }
  } else if (path.endsWith('.ts') || path.endsWith('.tsx')) {
    const { code, literals } = maskScript(text);
    scan(literals, HEX, 'hex-colour');
    // Scanned over all non-comment code, not only quoted literals, so Korean
    // written as JSX text is caught as well.
    if (!STRING_TABLES.has(path)) scan(code, HANGUL, 'hangul-literal');
  }
  return violations;
}

function listScannedFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : listScannedFiles(path);
    return /\.(css|ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/** Scans from the current directory, which must be the repo root; returns the exit code. */
export function main(): number {
  const violations = SCANNED_ROOTS.flatMap(listScannedFiles)
    .flatMap((path) => findDesignViolations(path, readFileSync(path, 'utf8')));
  for (const v of violations) console.log(`${v.path}:${v.line}: ${v.rule}: ${v.excerpt}`);
  return violations.length === 0 ? 0 : 1;
}

// Guarded so importing this module for tests never runs the CLI body; realpath
// for the same macOS /private symlink reason as register-discord-commands.ts.
const isEntryPoint = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);

if (isEntryPoint) {
  process.exitCode = main();
}
