import { describe, expect, test } from 'vitest';
import { findDesignViolations } from '../../scripts/lint-design';

function rulesOf(path: string, text: string): string[] {
  return findDesignViolations(path, text).map((v) => v.rule);
}

describe('findDesignViolations', () => {
  describe('hex colour literals', () => {
    test('a hex value in a CSS declaration is a violation, with its line', () => {
      const violations = findDesignViolations('components/ui/X.module.css', '.a {\n  color: #1b1e22;\n}\n');
      expect(violations).toEqual([
        { path: 'components/ui/X.module.css', line: 2, rule: 'hex-colour', excerpt: 'color: #1b1e22;' },
      ]);
    });

    test('a token reference in CSS is clean', () => {
      expect(rulesOf('components/ui/X.module.css', '.a { color: var(--text); }')).toEqual([]);
    });

    test('three- and eight-digit hex in a TS string literal are violations', () => {
      expect(rulesOf('lib/x.ts', "const a = '#fff';\nconst b = \"#0a0b0d80\";")).toEqual(['hex-colour', 'hex-colour']);
    });

    test('an issue reference in a comment is clean', () => {
      expect(rulesOf('lib/x.ts', '// see #58 and #123\n/* fixes #abc */\nconst a = 1;')).toEqual([]);
      expect(rulesOf('app/x.css', '/* per #123 */\n.a { color: var(--text); }')).toEqual([]);
    });

    test('a private class field that spells hex is clean', () => {
      expect(rulesOf('lib/x.ts', 'class A { #add = 1; }')).toEqual([]);
    });

    test('tokens.css may hold hex', () => {
      expect(rulesOf('tokens.css', ':root { --text: #e6e8eb; }')).toEqual([]);
    });
  });

  describe('Hangul outside the string tables', () => {
    test('Hangul in a string literal is a violation', () => {
      expect(rulesOf('app/x.tsx', "const label = '채널 관리';")).toEqual(['hangul-literal']);
    });

    test('Hangul in a template literal is a violation', () => {
      expect(rulesOf('lib/x.ts', 'const s = `${n}개`;')).toEqual(['hangul-literal']);
    });

    test('Hangul in a comment is clean', () => {
      expect(rulesOf('app/x.tsx', "// shows '채널 관리'\n/* 확인 */\nconst a = 'ok';")).toEqual([]);
    });

    test('a URL in a string does not start a comment that hides Hangul', () => {
      expect(rulesOf('lib/x.ts', "const u = 'https://x'; const s = '확인';")).toEqual(['hangul-literal']);
    });

    test('Hangul in lib/ui/copy.ts and lib/discord/copy.ts is clean', () => {
      expect(rulesOf('lib/ui/copy.ts', "export const A = '채널 관리';")).toEqual([]);
      expect(rulesOf('lib/discord/copy.ts', "export const A = '확인';")).toEqual([]);
    });

    test('ASCII string literals are clean', () => {
      expect(rulesOf('lib/x.ts', "const a = 'ok';")).toEqual([]);
    });
  });

  describe('px off the 4px scale', () => {
    test('an off-scale px value in CSS is a violation', () => {
      expect(rulesOf('app/x.css', '.a { padding: 7px 8px; }')).toEqual(['px-scale']);
    });

    test('multiples of 4, 1px, 2px and the type sizes are clean', () => {
      const css = '.a { padding: 4px 16px; border: 1px solid; border-radius: 2px; margin: -8px; width: 0px; }\n'
        + '.b { font-size: 13.5px; } .c { font-size: 12.5px; } .d { font-size: 11.5px; }\n'
        + '.e { font-size: 11px; } .f { font-size: 10px; }';
      expect(rulesOf('app/x.css', css)).toEqual([]);
    });

    test('px values in a CSS comment are clean', () => {
      expect(rulesOf('app/x.css', '/* was 7px */\n.a { padding: 8px; }')).toEqual([]);
    });
  });

  describe('--faint outside a disabled context', () => {
    test('--faint in a rule without a disabled selector is a violation', () => {
      expect(rulesOf('app/x.css', '.hint {\n  color: var(--faint);\n}')).toEqual(['faint-not-disabled']);
    });

    test('--faint under :disabled or [aria-disabled] is clean, including inside @media', () => {
      const css = '.b:disabled { color: var(--faint); }\n'
        + '@media (max-width: 640px) { .o[aria-disabled="true"] { color: var(--faint); } }';
      expect(rulesOf('app/x.css', css)).toEqual([]);
    });

    test('a selector list with one non-disabled member is a violation', () => {
      expect(rulesOf('app/x.css', '.b:disabled, .hint { color: var(--faint); }')).toEqual(['faint-not-disabled']);
    });
  });
});
