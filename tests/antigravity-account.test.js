import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockPoolManager = {
    setProviderNameIfEmpty: jest.fn(),
    markProviderUnhealthyImmediately: jest.fn()
};

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: () => mockPoolManager
}));

// tls-sidecar 在模块顶层使用 import.meta.url，babel-jest 下无法加载；这里用不到它
jest.mock('../src/utils/tls-sidecar.js', () => ({ getTLSSidecar: () => null }));
// open 是纯 ESM 包，babel-jest 不转换 node_modules；测试中不会打开浏览器
jest.mock('open', () => jest.fn());
// auth.js 加载时会启动 token 清理定时器，导致 jest 无法退出；这里用不到它
jest.mock('../src/ui-modules/auth.js', () => ({}));

// babel-jest 会把 jest.mock 提升到 import 之前，antigravity-core 拿到的是 mock 的号池管理器
import { AntigravityApiService } from '../src/providers/gemini/antigravity-core.js';
import { readCredentialEmail, createProviderConfig } from '../src/utils/provider-utils.js';

/**
 * 构造一个 payload 中带 email 的 JWT（签名无关紧要，只解析 payload）
 */
function fakeIdToken(payload) {
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    return `${b64({ alg: 'RS256' })}.${b64(payload)}.signature`;
}

const VALIDATION_URL = 'https://accounts.google.com/signin/continue?sarp=1&plt=example';

function createService(loadResponse, extraCalls = {}) {
    const service = new AntigravityApiService({
        MODEL_PROVIDER: 'gemini-antigravity',
        uuid: 'node-1',
        ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: '/nonexistent/creds.json'
    });
    service.authClient.credentials = { access_token: 'token' };
    service.authClient.getTokenInfo = jest.fn(async () => ({ email: 'user@example.com' }));
    service.fetchAvailableModels = jest.fn(async () => {});
    service.callApi = jest.fn(async (method) => {
        if (method === 'loadCodeAssist') return loadResponse;
        if (extraCalls[method]) return extraCalls[method]();
        throw new Error(`unexpected call: ${method}`);
    });
    return service;
}

describe('Antigravity 账号需要验证时停止 onboarding', () => {
    beforeEach(() => {
        mockPoolManager.setProviderNameIfEmpty.mockClear();
        mockPoolManager.markProviderUnhealthyImmediately.mockClear();
    });

    test('VALIDATION_REQUIRED：不 onboard、标记不健康，并带上验证链接', async () => {
        const service = createService({
            allowedTiers: [{ id: 'standard-tier', isDefault: true }],
            ineligibleTiers: [{
                reasonCode: 'VALIDATION_REQUIRED',
                tierId: 'free-tier',
                validationErrorMessage: 'Verify your account to continue.',
                validationUrl: VALIDATION_URL
            }]
        });

        const error = await service.discoverProjectAndModels().catch(e => e);

        expect(error.code).toBe('ANTIGRAVITY_VALIDATION_REQUIRED');
        expect(error.message).toContain(VALIDATION_URL);
        expect(error.shouldSwitchCredential).toBe(true);
        expect(service.callApi).not.toHaveBeenCalledWith('onboardUser', expect.anything());
        expect(service.projectId).toBeUndefined();
        expect(mockPoolManager.markProviderUnhealthyImmediately).toHaveBeenCalledWith(
            'gemini-antigravity',
            { uuid: 'node-1' },
            expect.stringContaining(VALIDATION_URL)
        );
    });

    test('已有项目的账号不受影响', async () => {
        const service = createService({
            cloudaicompanionProject: 'aicode-consumers',
            allowedTiers: [{ id: 'free-tier', isDefault: true }]
        });

        await expect(service.discoverProjectAndModels()).resolves.toBe('aicode-consumers');
        expect(mockPoolManager.markProviderUnhealthyImmediately).not.toHaveBeenCalled();
    });

    test('无需验证的新账号照常 onboard', async () => {
        const service = createService(
            { allowedTiers: [{ id: 'free-tier', isDefault: true }] },
            { onboardUser: async () => ({ done: true, response: { cloudaicompanionProject: { id: 'new-project' } } }) }
        );

        await expect(service.discoverProjectAndModels()).resolves.toBe('new-project');
        expect(mockPoolManager.markProviderUnhealthyImmediately).not.toHaveBeenCalled();
    });

    test('发现账号邮箱后用它命名未命名的节点', async () => {
        const service = createService({ cloudaicompanionProject: 'aicode-consumers' });
        await service.discoverProjectAndModels();
        expect(mockPoolManager.setProviderNameIfEmpty).toHaveBeenCalledWith('gemini-antigravity', 'node-1', 'user@example.com');
    });
});

describe('号池节点以账号邮箱命名', () => {
    let dir;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cred-email-'));
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    async function writeCreds(name, data) {
        const file = path.join(dir, name);
        await fs.writeFile(file, JSON.stringify(data));
        return file;
    }

    test('从 Google OAuth 的 id_token 中读取邮箱', async () => {
        const file = await writeCreds('google.json', {
            access_token: 'a',
            refresh_token: 'r',
            id_token: fakeIdToken({ email: 'someone@gmail.com', sub: '123' })
        });
        await expect(readCredentialEmail(file)).resolves.toBe('someone@gmail.com');
    });

    test('优先使用文件中的 email 字段', async () => {
        const file = await writeCreds('codex.json', {
            email: 'direct@example.com',
            id_token: fakeIdToken({ email: 'other@example.com' })
        });
        await expect(readCredentialEmail(file)).resolves.toBe('direct@example.com');
    });

    test('没有邮箱信息时返回 null', async () => {
        const file = await writeCreds('kiro.json', { accessToken: 'a', refreshToken: 'r' });
        await expect(readCredentialEmail(file)).resolves.toBeNull();
        await expect(readCredentialEmail(path.join(dir, 'missing.json'))).resolves.toBeNull();
    });

    test('createProviderConfig 写入 customName，未提供时不写', () => {
        const base = { credPathKey: 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH', credPath: './configs/antigravity/a.json' };
        expect(createProviderConfig({ ...base, customName: 'someone@gmail.com' }).customName).toBe('someone@gmail.com');
        expect(createProviderConfig({ ...base, customName: null })).not.toHaveProperty('customName');
    });
});
