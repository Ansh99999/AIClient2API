import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/convert/convert.js', () => ({
    convertData: jest.fn()
}));

jest.mock('../src/providers/provider-models.js', () => ({
    getConfiguredSupportedModels: jest.fn(() => []),
    getCustomModelListProvider: jest.fn(),
    getProviderModels: jest.fn(() => []),
    normalizeModelIds: jest.fn(models => models)
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    configureAxiosProxy: jest.fn(),
    configureTLSSidecar: jest.fn(),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null)
}));

let KiroApiService;
let ProviderPoolManager;

beforeAll(async () => {
    ({ KiroApiService } = await import('../src/providers/claude/claude-kiro.js'));
    ({ ProviderPoolManager } = await import('../src/providers/provider-pool-manager.js'));
});

function createInitializedService() {
    const service = new KiroApiService({ uuid: 'test-credential' });
    service.isInitialized = true;
    service._markCredentialNeedRefresh = jest.fn();
    return service;
}

describe('Kiro access token refresh before requests', () => {
    let service;

    beforeEach(() => {
        service = createInitializedService();
    });

    test('waits for an expired token refresh before a non-streaming request', async () => {
        const order = [];
        service.expiresAt = new Date(Date.now() - 60_000).toISOString();
        service.initializeAuth = jest.fn(async () => {
            order.push('refresh');
            service.expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
        });
        service.estimateInputTokens = jest.fn(() => 1);
        service.callApi = jest.fn(async () => {
            order.push('request');
            return {};
        });
        service._processApiResponse = jest.fn(() => ({
            responseText: 'ok',
            toolCalls: []
        }));

        await service.generateContent('claude-sonnet-4-5', {});

        expect(order).toEqual(['refresh', 'request']);
        expect(service.initializeAuth).toHaveBeenCalledWith(true);
        expect(service._markCredentialNeedRefresh).not.toHaveBeenCalled();
    });

    test('waits for an expired token refresh before starting a stream', async () => {
        const order = [];
        let releaseRefresh;
        const refreshFinished = new Promise(resolve => {
            releaseRefresh = resolve;
        });

        service.expiresAt = new Date(Date.now() - 60_000).toISOString();
        service.initializeAuth = jest.fn(async () => {
            order.push('refresh');
            await refreshFinished;
        });
        service.estimateInputTokens = jest.fn(() => 1);
        service.streamApiReal = jest.fn(async function* () {
            order.push('request');
            yield { type: 'content', content: 'ok' };
        });

        const stream = service._generateContentStreamRaw('claude-sonnet-4-5', {});
        const firstEventPromise = stream.next();
        await Promise.resolve();

        expect(order).toEqual(['refresh']);
        expect(service.streamApiReal).not.toHaveBeenCalled();

        releaseRefresh();
        const firstEvent = await firstEventPromise;
        expect(firstEvent.value.type).toBe('message_start');

        await stream.next();
        expect(order).toEqual(['refresh', 'request']);
    });

    test('keeps near-expiry tokens on the non-blocking background path', async () => {
        service.expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
        service.initializeAuth = jest.fn();

        await service._prepareAccessTokenForRequest('generateContentStream');

        expect(service.initializeAuth).not.toHaveBeenCalled();
        expect(service._markCredentialNeedRefresh).toHaveBeenCalledWith(
            'Token near expiry in generateContentStream'
        );
    });

    test('coalesces concurrent forced refreshes for the same credential', async () => {
        let releaseRefresh;
        const refreshFinished = new Promise(resolve => {
            releaseRefresh = resolve;
        });

        service.accessToken = 'expired-access-token';
        service.refreshToken = 'refresh-token';
        service.loadCredentials = jest.fn();
        service._doTokenRefresh = jest.fn(async () => {
            await refreshFinished;
        });

        const firstRefresh = service.initializeAuth(true);
        const secondRefresh = service.initializeAuth(true);
        await Promise.resolve();
        await Promise.resolve();

        expect(service._doTokenRefresh).toHaveBeenCalledTimes(1);

        releaseRefresh();
        await Promise.all([firstRefresh, secondRefresh]);
        expect(service._tokenRefreshPromise).toBeNull();
    });

    test('joins an in-flight refresh before reloading credentials', async () => {
        let signalRefreshStarted;
        let releaseRefresh;
        const refreshStarted = new Promise(resolve => {
            signalRefreshStarted = resolve;
        });
        const refreshFinished = new Promise(resolve => {
            releaseRefresh = resolve;
        });

        service.accessToken = 'expired-access-token';
        service.refreshToken = 'refresh-token';
        let loadCount = 0;
        service.loadCredentials = jest.fn(async () => {
            loadCount++;
            if (loadCount > 1) {
                service.accessToken = 'stale-token-reloaded-from-disk';
            }
        });
        service._doTokenRefresh = jest.fn(async () => {
            service.accessToken = 'fresh-access-token';
            signalRefreshStarted();
            await refreshFinished;
        });

        const firstRefresh = service.initializeAuth(true);
        await refreshStarted;
        const secondRefresh = service.initializeAuth(true);
        await Promise.resolve();

        expect(service.loadCredentials).toHaveBeenCalledTimes(1);
        expect(service.accessToken).toBe('fresh-access-token');

        releaseRefresh();
        await Promise.all([firstRefresh, secondRefresh]);
        expect(service.accessToken).toBe('fresh-access-token');
    });

    test('treats an invalid expiry timestamp as expired', () => {
        service.expiresAt = 'not-a-date';

        expect(service.isTokenExpired()).toBe(true);
    });
});

describe('Provider refresh queue slots', () => {
    test('releases the global slot after queued tasks for one provider finish', async () => {
        const manager = new ProviderPoolManager({}, {
            globalConfig: {
                REFRESH_CONCURRENCY_GLOBAL: 1,
                REFRESH_CONCURRENCY_PER_PROVIDER: 1
            }
        });
        manager._refreshNodeToken = jest.fn(async () => {});

        const first = {
            uuid: 'first',
            config: { uuid: 'first', isDisabled: false }
        };
        const second = {
            uuid: 'second',
            config: { uuid: 'second', isDisabled: false }
        };

        manager._enqueueRefreshImmediate('claude-kiro-oauth', first, true);
        manager._enqueueRefreshImmediate('claude-kiro-oauth', second, true);

        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));

        expect(manager._refreshNodeToken).toHaveBeenCalledTimes(2);
        expect(manager.activeProviderRefreshes).toBe(0);
        expect(manager.refreshingUuids.size).toBe(0);
        expect(manager.refreshQueues['claude-kiro-oauth']).toBeUndefined();
    });
});
