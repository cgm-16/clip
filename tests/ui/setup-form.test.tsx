// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

// vitest.config.mts does not set `test.globals`, so React Testing Library's
// automatic afterEach cleanup never registers. Without this, renders leak
// across tests. See tests/ui/primitives.test.tsx for the same pattern.
afterEach(cleanup);

const navigation = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));

import { ScreenA } from '@/app/setup/[token]/ScreenA';
import { ScreenB, type SaveOutcome } from '@/app/setup/[token]/ScreenB';
import { ScreenC } from '@/app/setup/[token]/ScreenC';
import { SetupFlow } from '@/app/setup/[token]/SetupFlow';
import { WEB_COPY, WEB_COPY_AUTHORED, WEB_COPY_TEMPLATES } from '@/lib/ui/copy';

const CHANNELS = [
  { id: '111', name: 'clip-archive', type: 0 },
  { id: '222', name: 'general', type: 0 },
];

const ROLES = [
  { id: 'g1', name: '@everyone', selectable: false },
  { id: 'm', name: 'moderator', selectable: true },
];

/** A full `/setup/data` body; tests override only what they exercise. */
function setupDataBody(overrides: Record<string, unknown> = {}) {
  return {
    guildId: 'g1',
    guildName: 'Test guild',
    adminHandle: 'admin',
    channels: CHANNELS,
    roles: ROLES,
    config: null,
    ...overrides,
  };
}

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

  it('starts existing-channel selection at the approved empty placeholder', async () => {
    const user = userEvent.setup();
    render(<ScreenB channels={CHANNELS} onSubmit={vi.fn()} />);

    await user.click(screen.getByRole('radio', { name: WEB_COPY.setup.destinationExistingLabel }));

    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(
      screen.getByRole('option', { name: WEB_COPY_AUTHORED.setupExistingChannelPlaceholder }),
    ).toHaveValue('');
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
    const onSubmit = vi.fn().mockResolvedValue({ kind: 'saved' });
    render(<ScreenB channels={CHANNELS} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ destination: 'create', channelId: null, allowedRoleIds: [] }));
  });

  it('submits the chosen channel id for the existing-channel destination', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue({ kind: 'saved' });
    render(<ScreenB channels={CHANNELS} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('radio', { name: WEB_COPY.setup.destinationExistingLabel }));
    await user.selectOptions(screen.getByRole('combobox'), '#clip-archive');
    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ destination: 'existing', channelId: '111', allowedRoleIds: [] }),
    );
  });

  it('disables the submit button while the save is pending, and re-enables after', async () => {
    const user = userEvent.setup();
    let resolveSubmit: (value: SaveOutcome) => void = () => {};
    const onSubmit = vi.fn(
      () =>
        new Promise<SaveOutcome>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    render(<ScreenB channels={CHANNELS} onSubmit={onSubmit} />);

    const saveButton = screen.getByRole('button', { name: WEB_COPY.setup.save });
    await user.click(saveButton);

    await waitFor(() => expect(saveButton).toBeDisabled());
    resolveSubmit({ kind: 'saved' });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
  });

  it('renders the save-failed error callout, with the 오류 tag, when onSubmit resolves false, and stays on Screen B', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue({ kind: 'failed' });
    render(<ScreenB channels={CHANNELS} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));

    // The copy wraps a mono "/setup" token, so match the surrounding text via
    // a function matcher rather than an exact string, the same technique
    // ScreenA's recovery callout test uses.
    expect(
      await screen.findByText((_, node) => node?.textContent === WEB_COPY_AUTHORED.saveFailed),
    ).toBeInTheDocument();
    expect(screen.getByText('오류')).toBeInTheDocument();
    // Still Screen B — the form itself remains rendered.
    expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument();
  });

  it('clears the save-failed error once a following retry is submitted', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValueOnce({ kind: 'failed' }).mockResolvedValueOnce({ kind: 'saved' });
    render(<ScreenB channels={CHANNELS} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));
    await screen.findByText('오류');

    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('오류')).not.toBeInTheDocument();
  });

  it('renders the save-failed error inside an aria-live region', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue({ kind: 'failed' });
    render(<ScreenB channels={CHANNELS} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));

    const errorText = await screen.findByText('오류');
    expect(errorText.closest('[aria-live]')).toHaveAttribute('aria-live', 'polite');
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
    render(<ScreenB channels={CHANNELS} onSubmit={vi.fn().mockResolvedValue({ kind: 'saved' })} />);

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

describe('ScreenC — setup complete', () => {
  const BASE_PROPS = {
    guildId: 'g1',
    archiveChannelId: '111',
    archiveChannelName: 'clip-archive',
    autoCreated: false,
    clipCount: 5,
    allowedRoles: [],
  };

  it('renders the READY tag and title', () => {
    render(<ScreenC {...BASE_PROPS} />);
    expect(screen.getByText(WEB_COPY.setupComplete.readyTag)).toBeInTheDocument();
    expect(screen.getByText(WEB_COPY.setupComplete.title)).toBeInTheDocument();
  });

  it('renders the three key/value rows: archive channel, admin-only, clip count', () => {
    render(<ScreenC {...BASE_PROPS} />);
    expect(screen.getByText(WEB_COPY.setupComplete.archiveChannelKey)).toBeInTheDocument();
    expect(screen.getByText('#clip-archive')).toBeInTheDocument();
    expect(screen.getByText(WEB_COPY.setupComplete.adminsKey)).toBeInTheDocument();
    expect(screen.getByText(WEB_COPY.setupComplete.adminsValue)).toBeInTheDocument();
    expect(screen.getByText(WEB_COPY.setupComplete.clipCountKey)).toBeInTheDocument();
    expect(
      screen.getByText(WEB_COPY_TEMPLATES.clipCount.replace('{count}', '5')),
    ).toBeInTheDocument();
    // No allowed-roles row -- roles are cut from P0.
    expect(screen.queryByText(WEB_COPY.setupComplete.allowedRolesKey)).not.toBeInTheDocument();
  });

  it('reflects the real clip count, not the mockup literal', () => {
    render(<ScreenC {...BASE_PROPS} clipCount={0} />);
    expect(screen.getByText(WEB_COPY_TEMPLATES.clipCount.replace('{count}', '0'))).toBeInTheDocument();
    expect(screen.queryByText('47개')).not.toBeInTheDocument();
  });

  it('renders the stepped usage row with the Clip token as a mono chip', () => {
    render(<ScreenC {...BASE_PROPS} />);
    expect(screen.getByText(WEB_COPY.setupComplete.usageHeading)).toBeInTheDocument();
    expect(screen.getByText('메시지 우클릭')).toBeInTheDocument();
    expect(screen.getByText('앱')).toBeInTheDocument();
    expect(screen.getByText('Clip')).toBeInTheDocument();
  });

  it('hides the auto-created OK callout when the channel was not auto-created', () => {
    render(<ScreenC {...BASE_PROPS} autoCreated={false} />);
    expect(
      screen.queryByText((_, node) => node?.textContent === WEB_COPY.setupComplete.manageChannelNoLongerNeeded),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('OK')).not.toBeInTheDocument();
  });

  it('shows the auto-created OK callout when the channel was auto-created', () => {
    render(<ScreenC {...BASE_PROPS} autoCreated />);
    expect(screen.getByText('OK')).toBeInTheDocument();
    expect(
      screen.getByText((_, node) => node?.textContent === WEB_COPY.setupComplete.manageChannelNoLongerNeeded),
    ).toBeInTheDocument();
  });

  it('Screen C opens the web archive and Screen E (decision D1)', () => {
    render(<ScreenC {...BASE_PROPS} guildId="g1" archiveChannelId="111" />);
    expect(screen.getByRole('link', { name: WEB_COPY.setupComplete.openArchive })).toHaveAttribute(
      'href',
      '/admin/g1/archive',
    );
    expect(screen.getByRole('link', { name: WEB_COPY.setupComplete.reviewSettings })).toHaveAttribute(
      'href',
      '/admin/g1/settings',
    );
  });
});

describe('SetupFlow — session exchange and Screen A/B branching', () => {
  afterEach(() => {
    window.sessionStorage.clear();
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

  it('shows a retryable load error without exchanging an unspent token', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/setup/data')) {
        return new Response(null, { status: 502 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SetupFlow token="fresh-token" />);

    expect(await screen.findByText(WEB_COPY_AUTHORED.setupDataLoadFailed)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: WEB_COPY_AUTHORED.retry })).toBeInTheDocument();
    expect(screen.getByText(WEB_COPY.tags.error)).toBeInTheDocument();
    expect(screen.queryByText(WEB_COPY.expiredSetupLink.title)).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/setup/exchange')),
    ).toHaveLength(0);
  });

  it('retries setup data after a load error, then exchanges the still-unspent token exactly once (#62)', async () => {
    const user = userEvent.setup();
    let dataCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/setup/data')) {
        dataCalls += 1;
        return dataCalls === 1
          ? new Response(null, { status: 502 })
          : Response.json(setupDataBody());
      }
      if (url.endsWith('/api/setup/exchange')) {
        return Response.json({ guildId: 'g1' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SetupFlow token="fresh-token" />);
    await screen.findByText(WEB_COPY_AUTHORED.setupDataLoadFailed);

    await user.click(screen.getByRole('button', { name: WEB_COPY_AUTHORED.retry }));

    await waitFor(() => expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument());
    // A live session does not stand in for a fresh link: the link's own token
    // decides which guild this page is for, and is spent exactly once.
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/setup/exchange')),
    ).toHaveLength(1);
  });

  it('keeps only one retry active while retried setup data is pending', async () => {
    const user = userEvent.setup();
    let resolveRetryData: (response: Response) => void = () => {};
    let dataCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/setup/exchange')) {
        return Response.json({ guildId: 'g1' });
      }
      if (!url.endsWith('/setup/data')) {
        throw new Error(`unexpected fetch: ${url}`);
      }
      dataCalls += 1;
      if (dataCalls === 1) {
        return new Response(null, { status: 502 });
      }
      if (dataCalls === 2) {
        return new Promise<Response>((resolve) => {
          resolveRetryData = resolve;
        });
      }
      return Response.json(setupDataBody());
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SetupFlow token="fresh-token" />);
    await screen.findByText(WEB_COPY_AUTHORED.setupDataLoadFailed);

    await user.click(screen.getByRole('button', { name: WEB_COPY_AUTHORED.retry }));

    await waitFor(() => expect(dataCalls).toBe(2));
    expect(screen.queryByRole('button', { name: WEB_COPY_AUTHORED.retry })).not.toBeInTheDocument();
    expect(screen.queryByText(WEB_COPY_AUTHORED.setupDataLoadFailed)).not.toBeInTheDocument();

    resolveRetryData(Response.json(setupDataBody()));
    await waitFor(() => expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument());
  });

  it('does not let a stale retry exchange a replaced token', async () => {
    const user = userEvent.setup();
    let resolveStaleRetry: (response: Response) => void = () => {};
    let resolveCurrentToken: (response: Response) => void = () => {};
    let dataCalls = 0;
    const exchangedTokens: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/setup/data')) {
        dataCalls += 1;
        if (dataCalls === 1) {
          return new Response(null, { status: 502 });
        }
        if (dataCalls === 2) {
          return new Promise<Response>((resolve) => {
            resolveStaleRetry = resolve;
          });
        }
        if (dataCalls === 3) {
          return new Promise<Response>((resolve) => {
            resolveCurrentToken = resolve;
          });
        }
        return Response.json(setupDataBody());
      }
      if (url.endsWith('/api/setup/exchange')) {
        exchangedTokens.push(JSON.parse(String(init?.body)).token);
        return Response.json({ guildId: 'g1' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const view = render(<SetupFlow token="stale-token" />);
    await screen.findByText(WEB_COPY_AUTHORED.setupDataLoadFailed);
    await user.click(screen.getByRole('button', { name: WEB_COPY_AUTHORED.retry }));
    await waitFor(() => expect(dataCalls).toBe(2));

    view.rerender(<SetupFlow token="current-token" />);
    await waitFor(() => expect(dataCalls).toBe(3));

    resolveStaleRetry(new Response(null, { status: 401 }));
    resolveCurrentToken(new Response(null, { status: 401 }));

    await waitFor(() => expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument());
    expect(exchangedTokens).toEqual(['current-token']);
  });

  it('does not let a stale exchange completion start post-exchange loading', async () => {
    let resolveStaleExchange: (response: Response) => void = () => {};
    let resolveCurrentExchange: (response: Response) => void = () => {};
    let dataCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/setup/data')) {
        dataCalls += 1;
        if (dataCalls <= 2) {
          return new Response(null, { status: 401 });
        }
        return Response.json(setupDataBody());
      }
      if (url.endsWith('/api/setup/exchange')) {
        const { token } = JSON.parse(String(init?.body));
        return new Promise<Response>((resolve) => {
          if (token === 'stale-token') {
            resolveStaleExchange = resolve;
          } else {
            resolveCurrentExchange = resolve;
          }
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const view = render(<SetupFlow token="stale-token" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    view.rerender(<SetupFlow token="current-token" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    resolveStaleExchange(Response.json({ guildId: 'g1' }));
    resolveCurrentExchange(Response.json({ guildId: 'g1' }));

    await waitFor(() => expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument());
    expect(dataCalls).toBe(3);
    expect(screen.queryByText(WEB_COPY.expiredSetupLink.title)).not.toBeInTheDocument();
  });

  it('returns to the load error and retries the token when the exchange request rejects', async () => {
    const user = userEvent.setup();
    let rejectExchange: (reason?: unknown) => void = () => {};
    let dataCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/setup/data')) {
        dataCalls += 1;
        if (dataCalls === 1) {
          return new Response(null, { status: 502 });
        }
        if (dataCalls === 2 || dataCalls === 3) {
          return new Response(null, { status: 401 });
        }
        return Response.json(setupDataBody());
      }
      if (url.endsWith('/api/setup/exchange')) {
        if (fetchMock.mock.calls.filter(([call]) => String(call).endsWith('/api/setup/exchange')).length === 1) {
          return new Promise<Response>((_, reject) => {
            rejectExchange = reject;
          });
        }
        return Response.json({ guildId: 'g1' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SetupFlow token="fresh-token" />);
    await screen.findByText(WEB_COPY_AUTHORED.setupDataLoadFailed);

    await user.click(screen.getByRole('button', { name: WEB_COPY_AUTHORED.retry }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/setup/exchange')),
      ).toHaveLength(1),
    );

    rejectExchange(new Error('network down'));

    expect(await screen.findByText(WEB_COPY_AUTHORED.setupDataLoadFailed)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: WEB_COPY_AUTHORED.retry }));

    await waitFor(() => expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument());
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/setup/exchange')),
    ).toHaveLength(2);
  });

  it('recovers a lost exchange response whose session cookie was delivered: the retry exchanges again and the server re-opens the token (#72)', async () => {
    const user = userEvent.setup();
    let rejectExchange: (reason?: unknown) => void = () => {};
    let exchangeCalls = 0;
    let dataCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/setup/data')) {
        dataCalls += 1;
        return dataCalls === 1
          ? new Response(null, { status: 401 })
          : Response.json(setupDataBody());
      }
      if (url.endsWith('/api/setup/exchange')) {
        exchangeCalls += 1;
        if (exchangeCalls === 1) {
          return new Promise<Response>((_, reject) => {
            rejectExchange = reject;
          });
        }
        // The first exchange did reach the server and its cookie reached the
        // browser; the token is spent, and the server re-opens it for the
        // session that exchange created.
        return Response.json({ guildId: 'g1' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SetupFlow token="fresh-token" />);
    await waitFor(() => expect(exchangeCalls).toBe(1));

    rejectExchange(new Error('response lost after the server established the session'));

    expect(await screen.findByText(WEB_COPY_AUTHORED.setupDataLoadFailed)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: WEB_COPY_AUTHORED.retry }));

    await waitFor(() => expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument());
    expect(exchangeCalls).toBe(2);
  });

  it('shows Screen A when a lost exchange response never delivered its session cookie', async () => {
    const user = userEvent.setup();
    let rejectExchange: (reason?: unknown) => void = () => {};
    let exchangeCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/setup/data')) {
        // No cookie ever reached the browser, so there is never a session.
        return new Response(null, { status: 401 });
      }
      if (url.endsWith('/api/setup/exchange')) {
        exchangeCalls += 1;
        if (exchangeCalls === 1) {
          return new Promise<Response>((_, reject) => {
            rejectExchange = reject;
          });
        }
        // The token is spent and the retry carries no session to re-open it.
        return new Response(null, { status: 401 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SetupFlow token="fresh-token" />);
    await waitFor(() => expect(exchangeCalls).toBe(1));

    rejectExchange(new Error('response and its Set-Cookie lost after the server spent the token'));

    expect(await screen.findByText(WEB_COPY_AUTHORED.setupDataLoadFailed)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: WEB_COPY_AUTHORED.retry }));

    expect(await screen.findByText(WEB_COPY.expiredSetupLink.title)).toBeInTheDocument();
    expect(exchangeCalls).toBe(2);
  });

  it('shows the load error for an unreadable exchange success, and the retry exchanges again', async () => {
    const user = userEvent.setup();
    let exchangeCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/setup/data')) {
        return exchangeCalls === 0 ? new Response(null, { status: 401 }) : Response.json(setupDataBody());
      }
      if (url.endsWith('/api/setup/exchange')) {
        exchangeCalls += 1;
        return exchangeCalls === 1 ? new Response(null, { status: 200 }) : Response.json({ guildId: 'g1' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SetupFlow token="fresh-token" />);

    expect(await screen.findByText(WEB_COPY_AUTHORED.setupDataLoadFailed)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: WEB_COPY_AUTHORED.retry }));

    await waitFor(() => expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument());
    expect(exchangeCalls).toBe(2);
  });

  it('keeps a stale exchange rejection from replacing the current flow', async () => {
    let rejectStaleExchange: (reason?: unknown) => void = () => {};
    let resolveCurrentExchange: (response: Response) => void = () => {};
    let dataCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/setup/data')) {
        dataCalls += 1;
        if (dataCalls <= 2) {
          return new Response(null, { status: 401 });
        }
        return Response.json(setupDataBody());
      }
      if (url.endsWith('/api/setup/exchange')) {
        const { token } = JSON.parse(String(init?.body));
        return new Promise<Response>((resolve, reject) => {
          if (token === 'stale-token') {
            rejectStaleExchange = reject;
          } else {
            resolveCurrentExchange = resolve;
          }
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const view = render(<SetupFlow token="stale-token" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    view.rerender(<SetupFlow token="current-token" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    rejectStaleExchange(new Error('network down'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText(WEB_COPY_AUTHORED.setupDataLoadFailed)).not.toBeInTheDocument();
    resolveCurrentExchange(Response.json({ guildId: 'g1' }));

    await waitFor(() => expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument());
  });

  it('does not load setup data after an unmounted exchange completes', async () => {
    let resolveExchange: (response: Response) => void = () => {};
    let dataCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/setup/data')) {
        dataCalls += 1;
        return new Response(null, { status: 401 });
      }
      if (url.endsWith('/api/setup/exchange')) {
        return new Promise<Response>((resolve) => {
          resolveExchange = resolve;
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const view = render(<SetupFlow token="fresh-token" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    view.unmount();
    resolveExchange(Response.json({ guildId: 'g1' }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dataCalls).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not do follow-up work when an unmounted exchange rejects', async () => {
    const unhandledRejection = vi.fn();
    window.addEventListener('unhandledrejection', unhandledRejection);
    let rejectExchange: (reason?: unknown) => void = () => {};
    let dataCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/setup/data')) {
        dataCalls += 1;
        return new Response(null, { status: 401 });
      }
      if (url.endsWith('/api/setup/exchange')) {
        return new Promise<Response>((_, reject) => {
          rejectExchange = reject;
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const view = render(<SetupFlow token="fresh-token" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    view.unmount();
    rejectExchange(new Error('network down'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dataCalls).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(unhandledRejection).not.toHaveBeenCalled();
    window.removeEventListener('unhandledrejection', unhandledRejection);
  });

  it('does not let stale post-exchange data replace a current loading flow', async () => {
    let resolveStaleData: (response: Response) => void = () => {};
    let resolveCurrentData: (response: Response) => void = () => {};
    let dataCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/setup/data')) {
        dataCalls += 1;
        if (dataCalls === 1) {
          return new Response(null, { status: 401 });
        }
        if (dataCalls >= 4) {
          // The current token's own post-exchange load.
          return Response.json(setupDataBody());
        }
        return new Promise<Response>((resolve) => {
          if (dataCalls === 2) {
            resolveStaleData = resolve;
          } else {
            resolveCurrentData = resolve;
          }
        });
      }
      if (url.endsWith('/api/setup/exchange')) {
        return Response.json({ guildId: 'g1' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const view = render(<SetupFlow token="stale-token" />);
    await waitFor(() => expect(dataCalls).toBe(2));

    view.rerender(<SetupFlow token="current-token" />);
    await waitFor(() => expect(dataCalls).toBe(3));

    resolveStaleData(new Response(null, { status: 502 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText(WEB_COPY_AUTHORED.setupDataLoadFailed)).not.toBeInTheDocument();
    expect(screen.queryByText(WEB_COPY.expiredSetupLink.title)).not.toBeInTheDocument();

    resolveCurrentData(Response.json(setupDataBody()));
    await waitFor(() => expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument());
  });

  it('never exchanges again when retry follows a post-exchange load failure', async () => {
    const user = userEvent.setup();
    let dataCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/setup/data')) {
        dataCalls += 1;
        if (dataCalls === 1) {
          return new Response(null, { status: 401 });
        }
        if (dataCalls === 2) {
          return new Response(null, { status: 502 });
        }
        return Response.json(setupDataBody());
      }
      if (url.endsWith('/api/setup/exchange')) {
        return Response.json({ guildId: 'g1' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SetupFlow token="fresh-token" />);
    await screen.findByText(WEB_COPY_AUTHORED.setupDataLoadFailed);

    await user.click(screen.getByRole('button', { name: WEB_COPY_AUTHORED.retry }));

    await waitFor(() => expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument());
    expect(dataCalls).toBe(3);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/setup/exchange'))).toHaveLength(1);
  });

  it('exchanges the token once, then renders Screen B with the fetched channels', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/setup/data')) {
        // First call (no session yet) fails; the retry after exchange succeeds.
        if (fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/setup/data')).length === 1) {
          return new Response(null, { status: 401 });
        }
        return Response.json(setupDataBody());
      }
      if (url.endsWith('/api/setup/exchange')) {
        return Response.json({ guildId: 'g1' });
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

  it('a fresh link exchanges its own token instead of trusting a live session for another guild (#62)', async () => {
    let exchanged = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/setup/exchange')) {
        exchanged = true;
        return Response.json({ guildId: 'gB' });
      }
      if (url.endsWith('/setup/data')) {
        // Before the exchange the cookie belongs to guild A (configured);
        // after it, to the link's own guild B.
        return Response.json(
          exchanged
            ? setupDataBody({ guildId: 'gB', guildName: 'Guild B' })
            : setupDataBody({ guildId: 'gA', guildName: 'Guild A', config: { archiveChannelId: '111', allowedRoleIds: [] } }),
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SetupFlow token="fresh-b-token" />);

    expect(await screen.findByText('Guild B')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/setup/exchange'))).toHaveLength(1);
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it('a refused link shows Screen A even when a session for some guild is live (#62)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/setup/exchange')) {
          return new Response(null, { status: 401 });
        }
        if (url.endsWith('/setup/data')) {
          return Response.json(setupDataBody({ guildId: 'gA', config: { archiveChannelId: '111', allowedRoleIds: [] } }));
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    render(<SetupFlow token="expired-b-token" />);

    expect(await screen.findByText(WEB_COPY.expiredSetupLink.title)).toBeInTheDocument();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it('a reload after another guild\'s link took over the session shows Screen A, never that guild (#72)', async () => {
    // First load: this tab exchanges guild A's link.
    let sessionGuild: 'none' | 'gA' | 'gB' = 'none';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/setup/data')) {
        if (sessionGuild === 'none') {
          return new Response(null, { status: 401 });
        }
        return Response.json(
          sessionGuild === 'gA'
            ? setupDataBody({ guildId: 'gA', guildName: 'Guild A' })
            : setupDataBody({ guildId: 'gB', guildName: 'Guild B' }),
        );
      }
      if (url.endsWith('/api/setup/exchange')) {
        // The server's answer for A's token: spent on the first load, so only
        // A's own session may re-open it.
        if (sessionGuild === 'none') {
          sessionGuild = 'gA';
          return Response.json({ guildId: 'gA' });
        }
        return sessionGuild === 'gA' ? Response.json({ guildId: 'gA' }) : new Response(null, { status: 401 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = render(<SetupFlow token="a-token" />);
    expect(await screen.findByText('Guild A')).toBeInTheDocument();
    first.unmount();

    // Another tab opened guild B's link, replacing the browser's one session.
    sessionGuild = 'gB';
    render(<SetupFlow token="a-token" />);

    expect(await screen.findByText(WEB_COPY.expiredSetupLink.title)).toBeInTheDocument();
    expect(screen.queryByText('Guild B')).not.toBeInTheDocument();
  });

  it('shows Screen A, never the other guild, when another tab replaces the session between the exchange and the data load', async () => {
    let exchanged = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/setup/exchange')) {
        exchanged = true;
        return Response.json({ guildId: 'gA' }, { status: 200 });
      }
      if (url.endsWith('/setup/data')) {
        // Before the exchange there is no session; by the time the data load
        // runs, guild B's link has replaced the browser's one session cookie.
        return exchanged
          ? Response.json(setupDataBody({ guildId: 'gB', guildName: 'Guild B' }))
          : new Response(null, { status: 401 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SetupFlow token="a-token" />);

    expect(await screen.findByText(WEB_COPY.expiredSetupLink.title)).toBeInTheDocument();
    expect(screen.queryByText('Guild B')).not.toBeInTheDocument();
    expect(screen.queryByText(WEB_COPY.setup.destinationLegend)).not.toBeInTheDocument();
  });

  it('shows Screen A, never the other guild, when a retry after a post-exchange load error finds a replaced session', async () => {
    const user = userEvent.setup();
    let dataCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/setup/exchange')) {
        return Response.json({ guildId: 'gA' }, { status: 200 });
      }
      if (url.endsWith('/setup/data')) {
        dataCalls += 1;
        if (dataCalls === 1) {
          return new Response(null, { status: 401 });
        }
        if (dataCalls === 2) {
          return new Response(null, { status: 502 });
        }
        // Guild B's link replaced the session before the retry. B is
        // configured, so showing it would also redirect to B's settings.
        return Response.json(
          setupDataBody({ guildId: 'gB', guildName: 'Guild B', config: { archiveChannelId: '111', allowedRoleIds: [] } }),
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SetupFlow token="a-token" />);
    await screen.findByText(WEB_COPY_AUTHORED.setupDataLoadFailed);

    await user.click(screen.getByRole('button', { name: WEB_COPY_AUTHORED.retry }));

    expect(await screen.findByText(WEB_COPY.expiredSetupLink.title)).toBeInTheDocument();
    expect(screen.queryByText('Guild B')).not.toBeInTheDocument();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it('re-opening a used link with its own live session asks the exchange, and the server\'s re-open shows setup (#72)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/setup/data')) {
        return Response.json(setupDataBody());
      }
      if (url.endsWith('/api/setup/exchange')) {
        // Spent token, but the request carries the session it paid for.
        return Response.json({ guildId: 'g1' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SetupFlow token="already-used-token" />);

    await waitFor(() =>
      expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument(),
    );
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/setup/exchange')),
    ).toHaveLength(1);
  });

  it('posts the submission to /setup/save and renders Screen C with the response on success', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/setup/exchange')) {
        return Response.json({ guildId: 'g1' });
      }
      if (url.endsWith('/setup/data')) {
        return Response.json(setupDataBody());
      }
      if (url.endsWith('/setup/save')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          destination: 'create',
          channelId: null,
          allowedRoleIds: [],
          guildId: 'g1',
        });
        return Response.json({
          archiveChannelId: '999',
          archiveChannelName: 'clip-archive',
          autoCreated: true,
          clipCount: 0,
          allowedRoles: [],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SetupFlow token="fresh-token" />);
    await waitFor(() =>
      expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));

    await waitFor(() => expect(screen.getByText(WEB_COPY.setupComplete.title)).toBeInTheDocument());
    expect(screen.getByText('OK')).toBeInTheDocument(); // autoCreated callout
    expect(screen.getByRole('link', { name: WEB_COPY.setupComplete.openArchive })).toHaveAttribute(
      'href',
      '/admin/g1/archive',
    );
  });

  it('keeps Screen B for a 200 save response with the wrong shape', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/setup/exchange')) {
        return Response.json({ guildId: 'g1' });
      }
      if (url.endsWith('/setup/data')) {
        return Response.json(setupDataBody());
      }
      if (url.endsWith('/setup/save')) {
        return Response.json({ archiveChannelId: '999' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SetupFlow token="fresh-token" />);
    await waitFor(() =>
      expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));

    expect(
      await screen.findByText((_, node) => node?.textContent === WEB_COPY_AUTHORED.saveFailed),
    ).toBeInTheDocument();
    expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument();
    expect(screen.queryByText(WEB_COPY.setupComplete.title)).not.toBeInTheDocument();
  });

  it.each([-1, 0.5])('keeps Screen B for an invalid clip count of %p', async (clipCount) => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/setup/exchange')) {
        return Response.json({ guildId: 'g1' });
      }
      if (url.endsWith('/setup/data')) {
        return Response.json(setupDataBody());
      }
      if (url.endsWith('/setup/save')) {
        return Response.json({
          archiveChannelId: '999',
          archiveChannelName: 'clip-archive',
          autoCreated: false,
          clipCount,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SetupFlow token="fresh-token" />);
    await waitFor(() =>
      expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));

    expect(
      await screen.findByText((_, node) => node?.textContent === WEB_COPY_AUTHORED.saveFailed),
    ).toBeInTheDocument();
    expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument();
    expect(screen.queryByText(WEB_COPY.setupComplete.title)).not.toBeInTheDocument();
  });

  it('keeps Screen B for malformed JSON in a 200 save response', async () => {
    const user = userEvent.setup();
    const unhandledRejection = vi.fn();
    window.addEventListener('unhandledrejection', unhandledRejection);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/setup/exchange')) {
        return Response.json({ guildId: 'g1' });
      }
      if (url.endsWith('/setup/data')) {
        return Response.json(setupDataBody());
      }
      if (url.endsWith('/setup/save')) {
        return new Response('{not-json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SetupFlow token="fresh-token" />);
    await waitFor(() =>
      expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));

    expect(
      await screen.findByText((_, node) => node?.textContent === WEB_COPY_AUTHORED.saveFailed),
    ).toBeInTheDocument();
    expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument();
    expect(screen.queryByText(WEB_COPY.setupComplete.title)).not.toBeInTheDocument();
    expect(unhandledRejection).not.toHaveBeenCalled();
    window.removeEventListener('unhandledrejection', unhandledRejection);
  });

  it('shows the save-failed callout on Screen B when /setup/save fails, then clears it and advances to Screen C once a retry succeeds', async () => {
    const user = userEvent.setup();
    let saveAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/setup/exchange')) {
        return Response.json({ guildId: 'g1' });
      }
      if (url.endsWith('/setup/data')) {
        return Response.json(setupDataBody());
      }
      if (url.endsWith('/setup/save')) {
        saveAttempts += 1;
        if (saveAttempts === 1) {
          return new Response(null, { status: 502 });
        }
        return Response.json({
          archiveChannelId: '111',
          archiveChannelName: 'clip-archive',
          autoCreated: false,
          clipCount: 3,
          allowedRoles: [],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SetupFlow token="fresh-token" />);
    await waitFor(() =>
      expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));

    expect(
      await screen.findByText((_, node) => node?.textContent === WEB_COPY_AUTHORED.saveFailed),
    ).toBeInTheDocument();
    expect(screen.getByText('오류')).toBeInTheDocument();
    // Still Screen B — a failed save must never silently advance.
    expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));

    await waitFor(() => expect(screen.getByText(WEB_COPY.setupComplete.title)).toBeInTheDocument());
    expect(screen.queryByText('오류')).not.toBeInTheDocument();
  });

  it('shows Screen A when /setup/save refuses the session, since another link may have replaced it', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/setup/exchange')) {
        return Response.json({ guildId: 'g1' });
      }
      if (url.endsWith('/setup/data')) {
        return Response.json(setupDataBody());
      }
      if (url.endsWith('/setup/save')) {
        return new Response(null, { status: 401 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SetupFlow token="fresh-token" />);
    await waitFor(() =>
      expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));

    await waitFor(() => expect(screen.getByText(WEB_COPY.expiredSetupLink.title)).toBeInTheDocument());
    expect(screen.queryByText(WEB_COPY.setup.destinationLegend)).not.toBeInTheDocument();
  });

  it('shows the save-failed callout when the /setup/save request itself rejects, instead of throwing', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/setup/exchange')) {
        return Response.json({ guildId: 'g1' });
      }
      if (url.endsWith('/setup/data')) {
        return Response.json(setupDataBody());
      }
      if (url.endsWith('/setup/save')) {
        // What an offline / DNS / connection-reset save looks like: the
        // request rejects, so there is no Response to inspect at all.
        throw new Error('network down');
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SetupFlow token="fresh-token" />);
    await waitFor(() =>
      expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));

    expect(
      await screen.findByText((_, node) => node?.textContent === WEB_COPY_AUTHORED.saveFailed),
    ).toBeInTheDocument();
    expect(screen.getByText('오류')).toBeInTheDocument();
    // Still Screen B — a rejected save must never silently advance.
    expect(screen.getByText(WEB_COPY.setup.destinationLegend)).toBeInTheDocument();
    expect(screen.queryByText(WEB_COPY.setupComplete.title)).not.toBeInTheDocument();
  });
});

describe('Wave 4 — clipping roles and refused destinations', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a configured guild opens with its current channel and roles, and a roles-only save posts existing', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue({ kind: 'saved' });
    render(
      <ScreenB
        channels={CHANNELS}
        roles={ROLES}
        initial={{ archiveChannelId: '111', allowedRoleIds: [] }}
        onSubmit={onSubmit}
      />,
    );

    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.rolesPlaceholder }));
    await user.click(screen.getByRole('checkbox', { name: 'moderator' }));
    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ destination: 'existing', channelId: '111', allowedRoleIds: ['m'] }),
    );
  });

  it('shows the roles NOTE callout', () => {
    render(<ScreenB channels={CHANNELS} roles={ROLES} onSubmit={vi.fn()} />);

    expect(screen.getByRole('group', { name: WEB_COPY.setup.rolesLegend })).toBeInTheDocument();
    expect(screen.getByText(WEB_COPY.setup.rolesNote)).toBeInTheDocument();
  });

  it('names missing permissions as machine values under the refusal copy', async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn()
      .mockResolvedValue({ kind: 'missing-permissions', missingPermissions: ['READ_MESSAGE_HISTORY'] });
    render(
      <ScreenB
        channels={CHANNELS}
        roles={ROLES}
        initial={{ archiveChannelId: '111', allowedRoleIds: [] }}
        onSubmit={onSubmit}
      />,
    );

    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));

    expect(await screen.findByText(WEB_COPY_AUTHORED.destinationMissingPermissions)).toBeInTheDocument();
    expect(screen.getByText('READ_MESSAGE_HISTORY')).toBeInTheDocument();
    expect(screen.queryByText(/정보를 저장할 수 없습니다/)).not.toBeInTheDocument();
  });

  it('a blocked destination change shows its own explanation, not the generic failure', async () => {
    const user = userEvent.setup();
    render(<ScreenB channels={CHANNELS} roles={ROLES} onSubmit={vi.fn().mockResolvedValue({ kind: 'live-clips' })} />);

    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));

    expect(await screen.findByText(WEB_COPY_AUTHORED.destinationChangeBlocked)).toBeInTheDocument();
    expect(screen.queryByText(/정보를 저장할 수 없습니다/)).not.toBeInTheDocument();
  });

  it('Screen C lists the allowed roles', () => {
    render(
      <ScreenC
        guildId="g1"
        archiveChannelId="111"
        archiveChannelName="clip-archive"
        autoCreated={false}
        clipCount={0}
        allowedRoles={[{ id: 'm', name: 'moderator' }]}
      />,
    );

    expect(screen.getByText(WEB_COPY.setupComplete.allowedRolesKey)).toBeInTheDocument();
    expect(screen.getByText('@moderator')).toBeInTheDocument();
  });

  it('Screen C omits the role row when only admins can clip', () => {
    render(
      <ScreenC
        guildId="g1"
        archiveChannelId="111"
        archiveChannelName="clip-archive"
        autoCreated={false}
        clipCount={0}
        allowedRoles={[]}
      />,
    );

    expect(screen.queryByText(WEB_COPY.setupComplete.allowedRolesKey)).not.toBeInTheDocument();
  });

  it('a fresh link for a configured guild goes to Screen E (decision D1)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(setupDataBody({ config: { archiveChannelId: '111', allowedRoleIds: [] } }))),
    );

    render(<SetupFlow token="live-token" />);

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('/admin/g1/settings'));
    expect(screen.queryByText(WEB_COPY.setup.destinationLegend)).toBeNull();
  });

  it('the live-clips refusal links to the web archive (#59)', async () => {
    const user = userEvent.setup();
    render(
      <ScreenB
        channels={CHANNELS}
        archiveHref="/admin/g1/archive"
        onSubmit={vi.fn().mockResolvedValue({ kind: 'live-clips' } satisfies SaveOutcome)}
      />,
    );
    await user.click(screen.getByRole('button', { name: WEB_COPY.setup.save }));
    expect(await screen.findByRole('link', { name: WEB_COPY.setupComplete.openArchive })).toHaveAttribute(
      'href',
      '/admin/g1/archive',
    );
  });

  it('a deleted configured channel is called out with 누락 (#58)', async () => {
    render(
      <ScreenB
        channels={CHANNELS}
        initial={{ archiveChannelId: 'gone', allowedRoleIds: [] }}
        archiveChannelMissing
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByText(WEB_COPY.tags.missing)).toBeInTheDocument();
    expect(screen.getByText(WEB_COPY_AUTHORED.archiveChannelMissing)).toBeInTheDocument();
  });

  it('SetupFlow shows the guild id when Discord cannot supply the guild name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(setupDataBody({ guildName: null }))),
    );

    render(<SetupFlow token="live-token" />);

    expect(await screen.findByText('g1')).toBeInTheDocument();
  });
});
