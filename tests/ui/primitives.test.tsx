// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

// vitest.config.mts does not set `test.globals`, so React Testing Library's
// automatic afterEach cleanup (which detects a global `afterEach`) never
// registers. Without this, each render leaks into the next test's DOM and
// every repeated label ("READY", "레이블", ...) becomes ambiguous.
afterEach(cleanup);

import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Fieldset } from '@/components/ui/Fieldset';
import { MonoChip } from '@/components/ui/MonoChip';
import { RadioGroup } from '@/components/ui/RadioGroup';
import { Select } from '@/components/ui/Select';
import { TextInput } from '@/components/ui/TextInput';
import { TextTag } from '@/components/ui/TextTag';
import { WEB_COPY } from '@/lib/ui/copy';

describe('TextTag', () => {
  it('renders its text content', () => {
    render(<TextTag>READY</TextTag>);
    expect(screen.getByText('READY')).toBeInTheDocument();
  });

  it('applies a passed colour as an inline style, and inherits otherwise', () => {
    const { rerender } = render(<TextTag>READY</TextTag>);
    expect(screen.getByText('READY')).not.toHaveAttribute('style');

    rerender(<TextTag color="var(--success-text)">READY</TextTag>);
    expect(screen.getByText('READY')).toHaveStyle({ color: 'var(--success-text)' });
  });
});

describe('Button', () => {
  it('renders a real button, reachable and activatable by keyboard', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>설정 저장</Button>);

    const button = screen.getByRole('button', { name: '설정 저장' });
    expect(button.tagName).toBe('BUTTON');

    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard('[Enter]');
    expect(onClick).toHaveBeenCalledTimes(1);
    await user.keyboard('[Space]');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('defaults to type="button" so it never submits a form by accident', () => {
    render(<Button>취소</Button>);
    expect(screen.getByRole('button', { name: '취소' })).toHaveAttribute('type', 'button');
  });

  it('does not fire onClick when disabled, and is not reachable by tab', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick} disabled>Clip 데이터 삭제</Button>);

    const button = screen.getByRole('button', { name: 'Clip 데이터 삭제' });
    expect(button).toBeDisabled();
    await user.tab();
    expect(button).not.toHaveFocus();
  });

  it.each(['primary', 'secondary', 'danger'] as const)(
    'renders the %s variant',
    (variant) => {
      render(<Button variant={variant}>레이블</Button>);
      expect(screen.getByRole('button', { name: '레이블' })).toBeInTheDocument();
    },
  );
});

describe('TextInput', () => {
  it('is a real input reachable by its accessible label', async () => {
    const user = userEvent.setup();
    render(<TextInput id="channel-search" label="채널 이름 검색" />);

    const input = screen.getByLabelText('채널 이름 검색');
    expect(input.tagName).toBe('INPUT');
    await user.type(input, '#clip-archive');
    expect(input).toHaveValue('#clip-archive');
  });

  it('links an error message via aria-describedby and marks aria-invalid', () => {
    render(
      <TextInput
        id="channel-select-input"
        label="채널"
        errorMessage={WEB_COPY.setup.destinationChannelRequired}
      />,
    );
    const input = screen.getByLabelText('채널');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent(
      WEB_COPY.setup.destinationChannelRequired,
    );
  });

  it('has no aria-invalid when there is no error', () => {
    render(<TextInput id="plain" label="라벨" />);
    expect(screen.getByLabelText('라벨')).not.toHaveAttribute('aria-invalid');
  });
});

describe('Select', () => {
  it('is a real select reachable by its accessible label and choosable', async () => {
    const user = userEvent.setup();
    render(
      <Select
        id="channel-select"
        label="채널 선택"
        options={[
          { value: 'general', label: '#일반' },
          { value: 'archive', label: '#clip-archive' },
        ]}
      />,
    );
    const select = screen.getByLabelText('채널 선택');
    expect(select.tagName).toBe('SELECT');
    await user.selectOptions(select, 'archive');
    expect(select).toHaveValue('archive');
  });
});

describe('Fieldset', () => {
  it('is a real fieldset/legend pair, queryable as a labelled group', () => {
    render(
      <Fieldset legend={WEB_COPY.setup.destinationLegend}>
        <p>content</p>
      </Fieldset>,
    );
    const group = screen.getByRole('group', { name: WEB_COPY.setup.destinationLegend });
    expect(group.tagName).toBe('FIELDSET');
    expect(screen.getByText('content')).toBeInTheDocument();
  });
});

describe('RadioGroup', () => {
  const options = [
    { value: 'create', label: '비공개 아카이브 채널 새로 만들기 — 권장' },
    { value: 'existing', label: '기존 채널 사용' },
  ];

  it('renders real, independently labelled radio inputs sharing one name', () => {
    render(
      <RadioGroup
        legend={WEB_COPY.setup.destinationLegend}
        name="destination"
        options={options}
        value="create"
        onChange={() => {}}
      />,
    );
    const create = screen.getByRole('radio', { name: options[0].label });
    const existing = screen.getByRole('radio', { name: options[1].label });
    expect(create).toHaveAttribute('name', 'destination');
    expect(existing).toHaveAttribute('name', 'destination');
    expect(create).toBeChecked();
    expect(existing).not.toBeChecked();
  });

  it('is keyboard-operable: focusing an option and pressing Space selects it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <RadioGroup
        legend={WEB_COPY.setup.destinationLegend}
        name="destination"
        options={options}
        value="create"
        onChange={onChange}
      />,
    );
    const existing = screen.getByRole('radio', { name: options[1].label });
    existing.focus();
    await user.keyboard('[Space]');
    expect(onChange).toHaveBeenCalledWith('existing');
  });
});

describe('Callout', () => {
  it.each([
    ['note', WEB_COPY.tags.note],
    ['ok', WEB_COPY.tags.ok],
    ['confirm', WEB_COPY.tags.confirm],
    ['error', WEB_COPY.tags.error],
  ] as const)('renders the %s variant with its text tag, never colour alone', (variant, tag) => {
    render(<Callout variant={variant}>메시지 본문</Callout>);
    expect(screen.getByText(tag)).toBeInTheDocument();
    expect(screen.getByText('메시지 본문')).toBeInTheDocument();
  });
});

describe('MonoChip', () => {
  it('renders display-only content, not an interactive control', () => {
    render(<MonoChip>Clip</MonoChip>);
    const chip = screen.getByText('Clip');
    expect(chip.tagName).toBe('SPAN');
    expect(chip).not.toHaveAttribute('role', 'button');
    expect(chip.querySelector('button')).toBeNull();
  });
});

describe('--faint is disabled-controls-only', () => {
  // A regression test for the design system's hard accessibility rule: any
  // text a user must read uses --muted (5.37:1); --faint (3.2:1) is reserved
  // for disabled controls. Read the shipped CSS itself, since jsdom does not
  // apply component stylesheets and so cannot be asked via getComputedStyle.
  const uiDir = join(process.cwd(), 'components', 'ui');
  const cssFiles = readdirSync(uiDir).filter((f) => f.endsWith('.module.css'));

  it('found component stylesheets to check', () => {
    expect(cssFiles.length).toBeGreaterThan(0);
  });

  it.each(cssFiles)('every var(--faint) in %s sits in a disabled-only rule', (file) => {
    const css = readFileSync(`${uiDir}/${file}`, 'utf8');
    // Strip comments so a mention of --faint in prose doesn't count.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = withoutComments.match(/[^{}]+\{[^{}]*\}/g) ?? [];
    for (const rule of rules) {
      if (!rule.includes('--faint')) continue;
      const selector = rule.slice(0, rule.indexOf('{'));
      expect(
        /:disabled|\[disabled\]|\[aria-disabled="true"\]/.test(selector),
        `selector "${selector.trim()}" uses --faint but is not a disabled-only rule`,
      ).toBe(true);
    }
  });
});
