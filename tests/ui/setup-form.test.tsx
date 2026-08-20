// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

// vitest.config.mts does not set `test.globals`, so React Testing Library's
// automatic afterEach cleanup never registers. Without this, renders leak
// across tests. See tests/ui/primitives.test.tsx for the same pattern.
afterEach(cleanup);

import { ScreenA } from '@/app/setup/[token]/ScreenA';
import { ScreenB } from '@/app/setup/[token]/ScreenB';
import { SetupFlow } from '@/app/setup/[token]/SetupFlow';
import { WEB_COPY } from '@/lib/ui/copy';

const CHANNELS = [
  { id: '111', name: 'clip-archive', type: 0 },
  { id: '222', name: 'general', type: 0 },
];

describe('ScreenA — expired setup link', () => {
  it('renders the title, explanation, NOTE recovery callout and footnote', () => {
    render(<ScreenA />);
    expect(screen.getByText(WEB_COPY.expiredSetupLink.title)).toBeInTheDocument();
    expect(screen.getByText(WEB_COPY.expiredSetupLink.explanation)).toBeInTheDocument();
    expect(screen.getByText('NOTE')).toBeInTheDocument();
    // The recovery copy is split around the mono "/setup" command, so match
    // the surrounding text via a function matcher rather than exact string.
    expect(
      screen.getByText((_, node) => node?.textContent === WEB_COPY.expiredSetupLink.recovery),
    ).toBeInTheDocument();
    expect(screen.getByText(WEB_COPY.expiredSetupLink.archiveStillWorks)).toBeInTheDocument();
  });

  it('renders no form controls — it is a dead-end recovery screen, not a retry form', () => {
    render(<ScreenA />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });
});

describe('ScreenB — archive destination configuration', () => {
  it('defaults to the recommended "create new channel" destination with the channel select hidden', () => {
    render(<ScreenB channels={CHANNELS} onSubmit={vi.fn()} />);
    const createRadio = screen.getByRole('radio', {
      name: new RegExp(WEB_COPY.setup.destinationCreateLabel.split(' —')[0]),
    });
    expect(createRadio).toBeChecked();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('reveals the channel select and warning only once "기존 채널 사용" is chosen', async () => {
    const user = userEvent.setup();
    render(<ScreenB channels={CHANNELS} onSubmit={vi.fn()} />);

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: WEB_COPY.setup.destinationExistingLabel }));

    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.getByText(WEB_COPY.setup.destinationExistingWarning)).toBeInTheDocument();
  });

  it('lists the fetched channels, prefixed with #, in the revealed select', async () => {
    const user = userEvent.setup();
    render(<ScreenB channels={CHANNELS} onSubmit={vi.fn()} />);
    await user.click(screen.getByRole('radio', { name: WEB_COPY.setup.destinationExistingLabel }));

    expect(screen.getByRole('option', { name: '#clip-archive' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '#general' })).toBeInTheDocument();
  });

  it('refuses submit with no channel selected, showing the handoff validation string', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ScreenB channels={CHANNELS} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('radio', { name: WEB_COPY.setup.destinationExistingLabel }));
    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));

    expect(screen.getByText(WEB_COPY.setup.destinationChannelRequired)).toBeInTheDocument();
    expect(screen.getByText('확인')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('validates on blur, before any submit attempt', async () => {
    const user = userEvent.setup();
    render(<ScreenB channels={CHANNELS} onSubmit={vi.fn()} />);

    await user.click(screen.getByRole('radio', { name: WEB_COPY.setup.destinationExistingLabel }));
    const select = screen.getByRole('combobox');
    select.focus();
    await user.tab();

    expect(screen.getByText(WEB_COPY.setup.destinationChannelRequired)).toBeInTheDocument();
  });

  it('clears the validation error once a channel is chosen', async () => {
    const user = userEvent.setup();
    render(<ScreenB channels={CHANNELS} onSubmit={vi.fn()} />);

    await user.click(screen.getByRole('radio', { name: WEB_COPY.setup.destinationExistingLabel }));
    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));
    expect(screen.getByText(WEB_COPY.setup.destinationChannelRequired)).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox'), '#clip-archive');
    expect(screen.queryByText(WEB_COPY.setup.destinationChannelRequired)).not.toBeInTheDocument();
  });

  it('does not require a channel when the recommended "create new" destination is kept', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<ScreenB channels={CHANNELS} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ destination: 'create', channelId: null }));
  });

  it('submits the chosen channel id for the existing-channel destination', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<ScreenB channels={CHANNELS} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('radio', { name: WEB_COPY.setup.destinationExistingLabel }));
    await user.selectOptions(screen.getByRole('combobox'), '#clip-archive');
    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ destination: 'existing', channelId: '111' }),
    );
  });

  it('disables the submit button while the save is pending, and re-enables after', async () => {
    const user = userEvent.setup();
    let resolveSubmit: (value: boolean) => void = () => {};
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    render(<ScreenB channels={CHANNELS} onSubmit={onSubmit} />);

    const saveButton = screen.getByRole('button', { name: WEB_COPY.setup.save });
    await user.click(saveButton);

    await waitFor(() => expect(saveButton).toBeDisabled());
    resolveSubmit(true);
    await waitFor(() => expect(saveButton).not.toBeDisabled());
  });

  it('renders the required consent block verbatim', () => {
    render(<ScreenB channels={CHANNELS} onSubmit={vi.fn()} />);
    expect(screen.getByText(WEB_COPY.setup.consequencesHeading)).toBeInTheDocument();
    expect(screen.getByText(WEB_COPY.setup.consequenceClipping)).toBeInTheDocument();
    expect(screen.getByText(WEB_COPY.setup.consequenceStorage)).toBeInTheDocument();
    expect(screen.getByText(WEB_COPY.setup.consequenceAuthorRemoval)).toBeInTheDocument();
  });

  it('renders exactly one primary button on the screen', () => {
    render(<ScreenB channels={CHANNELS} onSubmit={vi.fn()} />);
    const save = screen.getByRole('button', { name: WEB_COPY.setup.save });
    const cancel = screen.getByRole('button', { name: WEB_COPY.setup.cancel });
    expect(save.className).toMatch(/primary/);
    expect(cancel.className).not.toMatch(/primary/);
  });

  it('is operable via keyboard: tab reaches the radios, select and buttons as real controls', async () => {
    const user = userEvent.setup();
    render(<ScreenB channels={CHANNELS} onSubmit={vi.fn()} />);

    await user.click(screen.getByRole('radio', { name: WEB_COPY.setup.destinationExistingLabel }));

    const select = screen.getByRole('combobox');
    select.focus();
    expect(document.activeElement).toBe(select);
    await user.selectOptions(select, '#general');
    expect(select).toHaveValue('222');

    const saveButton = screen.getByRole('button', { name: WEB_COPY.setup.save });
    saveButton.focus();
    expect(document.activeElement).toBe(saveButton);
    await user.keyboard('{Enter}');
  });
});

describe('SetupFlow — session exchange and Screen A/B branching', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders Screen A when the setup token is expired or already used', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/setup/data')) {
        return new Response(null, { status: 401 });
      }
      if (url.endsWith('/api/setup/exchange')) {
        return new Response(null, { status: 401 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SetupFlow token="dead-token" />);

    await waitFor(() => expect(screen.getByText(WEB_COPY.expiredSetupLink.title)).toBeInTheDocument());
  });

  it('exchanges the token once, then renders Screen B with the fetched channels', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/setup/data')) {
        // First call (no session yet) fails; the retry after exchange succeeds.
        if (fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/setup/data')).length === 1) {
          return new Response(null, { status: 401 });
        }
        return Response.json({ guildId: 'g1', channels: CHANNELS });
      }
      if (url.endsWith('/api/setup/exchange')) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SetupFlow token="fresh-token" />);

    await waitFor(() =>
      expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/setup/exchange',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('reuses an already-live admin session on reload, without re-exchanging the (now spent) token', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/setup/data')) {
        return Response.json({ guildId: 'g1', channels: CHANNELS });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SetupFlow token="already-used-token" />);

    await waitFor(() =>
      expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument(),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/setup/exchange',
      expect.anything(),
    );
  });
});
