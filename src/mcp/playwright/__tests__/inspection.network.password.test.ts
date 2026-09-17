import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSendRpc, getPage, resolveWorkspaceBackend } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
  resolveWorkspaceBackend: vi.fn(async () => 'builtin'),
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    (method.startsWith('browser.lease.') || method === 'browser.lifecycle.get')
      ? Promise.resolve({ token: null })
      : mockSendRpc(method, ...args),
}));

vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({
      getPageForScope: getPage,
      resolveWorkspaceBackend,
      drainLocalLifecycle: () => [],
    }),
  },
}));

import { registerInspectionTools } from '../tools/inspection';
import { REDACTED_CREDENTIAL, REDACTED_PASSWORD } from '../redact';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const browserToolDeps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

function collectTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerInspectionTools(server as never, browserToolDeps);
  return tools;
}

const tools = collectTools();
const network = tools.get('browser_network');
const responseBody = tools.get('browser_response_body');
const consoleTool = tools.get('browser_console');
const snapshot = tools.get('browser_snapshot');
if (!network || !responseBody || !consoleTool || !snapshot) {
  throw new Error('inspection tools failed to register');
}

beforeEach(() => {
  browserToolDeps.resolveWorkspaceId.mockClear();
  mockSendRpc.mockReset();
  getPage.mockReset();
  // Both tools take the RPC path when no Page exists, which is where the
  // main-process capture buffer is drained — the same formatter serves the
  // Playwright path.
  getPage.mockResolvedValue(null);
});

describe('browser_network — request listing', () => {
  it('masks a credential a page put in the query string', async () => {
    mockSendRpc.mockResolvedValue({
      entries: [
        { url: 'https://x.test/login?user=alice&password=hunter2SECRET', method: 'GET', status: 302 },
      ],
    });

    const result = await network({});

    expect(result.content[0].text).not.toContain('hunter2SECRET');
    expect(result.content[0].text).toContain(`password=${REDACTED_PASSWORD}`);
    // The field NAME and the rest of the request stay readable — this listing
    // exists to be debugged against.
    expect(result.content[0].text).toContain('user=alice');
    expect(result.content[0].text).toContain('"method": "GET"');
    expect(result.content[0].text).toContain('"status": 302');
  });

  it('leaves ordinary URLs untouched', async () => {
    mockSendRpc.mockResolvedValue({
      entries: [{ url: 'https://x.test/api/items?page=2&sort=name', method: 'GET', status: 200 }],
    });

    const result = await network({});

    expect(result.content[0].text).toContain('api/items?page=2&sort=name');
    expect(result.content[0].text).not.toContain(REDACTED_PASSWORD);
    expect(result.content[0].text).not.toContain(REDACTED_CREDENTIAL);
  });

  // #1354: the login flow that motivated this — an OAuth redirect chain the
  // listing used to print with the authorization code and the tokens intact.
  it('masks the OAuth authorization code and the tokens in a redirect chain', async () => {
    mockSendRpc.mockResolvedValue({
      entries: [
        { url: 'https://idp.test/authorize?client_id=app-1&redirect_uri=https%3A%2F%2Fx.test%2Fcb', method: 'GET', status: 302 },
        { url: 'https://x.test/cb?code=4%2F0AY0eSECRET&state=xyz789', method: 'GET', status: 302 },
        { url: 'https://x.test/session#access_token=eyJhbGSECRET&id_token=eyJraWSECRET', method: 'GET', status: 200 },
      ],
    });

    const result = await network({});
    const text = result.content[0].text;

    expect(text).not.toContain('SECRET');
    expect(text).toContain(`code=${REDACTED_CREDENTIAL}`);
    expect(text).toContain(`access_token=${REDACTED_CREDENTIAL}`);
    expect(text).toContain(`id_token=${REDACTED_CREDENTIAL}`);
    // The flow stays debuggable: hosts, paths, the non-secret parameters and
    // the status codes all survive.
    expect(text).toContain('idp.test/authorize?client_id=app-1');
    expect(text).toContain('state=xyz789');
    expect(text).toContain('"status": 302');
  });
});

describe('browser_response_body', () => {
  it('masks a JSON body that echoes the submitted credential back', async () => {
    mockSendRpc.mockResolvedValue({
      body: '{"error":"invalid","submitted":{"username":"alice","password":"hunter2SECRET"}}',
    });

    const result = await responseBody({ urlPattern: '*login*' });

    expect(result.content[0].text).not.toContain('hunter2SECRET');
    expect(result.content[0].text).toContain(`"password":"${REDACTED_PASSWORD}"`);
    expect(result.content[0].text).toContain('"username":"alice"');
    expect(result.content[0].text).toContain('"error":"invalid"');
  });

  it('masks a form-urlencoded echo', async () => {
    mockSendRpc.mockResolvedValue({ body: 'username=alice&password=hunter2SECRET&csrf=t0ken' });

    const result = await responseBody({ urlPattern: '*login*' });

    expect(result.content[0].text).toBe(
      `username=alice&password=${REDACTED_PASSWORD}&csrf=t0ken`,
    );
  });

  it('masks the token-exchange response (#1354)', async () => {
    mockSendRpc.mockResolvedValue({
      body: '{"access_token":"ya29.SECRET","id_token":"eyJhSECRET","token_type":"Bearer","expires_in":3599}',
    });

    const result = await responseBody({ urlPattern: '*token*' });
    const text = result.content[0].text;

    expect(text).not.toContain('SECRET');
    expect(text).toContain(`"access_token":"${REDACTED_CREDENTIAL}"`);
    expect(text).toContain(`"id_token":"${REDACTED_CREDENTIAL}"`);
    expect(text).toContain('"token_type":"Bearer"');
    expect(text).toContain('"expires_in":3599');
  });

  it('returns an unrelated body byte for byte', async () => {
    const body = '{"items":[{"id":1,"passport":"X123"}],"total":1}';
    mockSendRpc.mockResolvedValue({ body });

    const result = await responseBody({ urlPattern: '*api*' });

    expect(result.content[0].text).toBe(body);
  });
});

describe('browser_console', () => {
  it('masks a credential a page logged in its own payload', async () => {
    mockSendRpc.mockResolvedValue({
      entries: [
        { level: 'log', text: 'POST /login {"username":"alice","password":"hunter2SECRET"}' },
        { level: 'error', text: 'auth failed for password=hunter2SECRET' },
      ],
    });

    const result = await consoleTool({});
    const text = result.content[0].text;

    expect(text).not.toContain('hunter2SECRET');
    expect(text).toContain(`"password":"${REDACTED_PASSWORD}"`);
    expect(text).toContain(`password=${REDACTED_PASSWORD}`);
    // The level prefix and the surrounding message survive.
    expect(text).toContain('[log] POST /login');
    expect(text).toContain('[error] auth failed for');
  });

  it('masks a credential in a URL a page logged, and an Authorization header (#1354)', async () => {
    mockSendRpc.mockResolvedValue({
      entries: [
        { level: 'error', text: 'Failed to load https://x.test/cb?code=4%2F0AY0eSECRET&state=xyz' },
        { level: 'log', text: 'Authorization: Bearer eyJhbGciSECRET' },
      ],
    });

    const text = (await consoleTool({})).content[0].text;

    expect(text).not.toContain('SECRET');
    expect(text).toContain(`code=${REDACTED_CREDENTIAL}`);
    expect(text).toContain(`Authorization: ${REDACTED_CREDENTIAL}`);
    expect(text).toContain('Failed to load https://x.test/cb');
    expect(text).toContain('state=xyz');
  });

  it('passes ordinary log lines through byte for byte', async () => {
    mockSendRpc.mockResolvedValue({
      entries: [
        { level: 'warn', text: 'Deprecated API: passport.authenticate() will be removed' },
        { level: 'log', text: 'render took 12ms (a=1&b=2)' },
      ],
    });

    const result = await consoleTool({});
    const text = result.content[0].text;

    expect(text).toBe(
      [
        '[warn] Deprecated API: passport.authenticate() will be removed',
        '[log] render took 12ms (a=1&b=2)',
      ].join('\n'),
    );
  });
});

describe('browser_snapshot DOM-listing fallback', () => {
  it('masks credentials in the listing URL line without a live page', async () => {
    const listing = [
      'Page: Login',
      'URL: https://x.test/login?user=alice&password=hunter2SECRET',
      '',
      'Interactive elements (use ref number for click/fill/type):',
      '  [ref=0] input[type=password] name="password"',
    ].join('\n');
    mockSendRpc.mockResolvedValue({ value: listing });

    const result = await snapshot({ full: true });
    const text = result.content[0].text;

    expect(text).not.toContain('hunter2SECRET');
    expect(text).toContain(`password=${REDACTED_PASSWORD}`);
    // The field itself still has to be visible for the agent to fill it.
    expect(text).toContain('[ref=0] input[type=password] name="password"');
  });
});
