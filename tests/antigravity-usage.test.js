import { describe, test, expect, jest } from '@jest/globals';

// tls-sidecar 在模块顶层使用 import.meta.url，babel-jest 下无法加载；这里用不到它
jest.mock('../src/utils/tls-sidecar.js', () => ({ getTLSSidecar: () => null }));
// open 是纯 ESM 包，babel-jest 不转换 node_modules；测试中不会打开浏览器
jest.mock('open', () => jest.fn());
// auth.js 加载时会启动 token 清理定时器，导致 jest 无法退出；这里用不到它
jest.mock('../src/ui-modules/auth.js', () => ({}));

import { formatAntigravityUsage } from '../src/services/usage-service.js';

/**
 * Antigravity 用量格式化
 *
 * 样例取自 retrieveUserQuotaSummary 的真实响应：
 * 付费（Google AI Pro）账号每组有 5 小时 + 周限额，免费账号只有周限额。
 */
const PRO_SUMMARY = {
    groups: [
        {
            displayName: 'Gemini Models',
            buckets: [
                { bucketId: 'gemini-weekly', window: 'weekly', resetTime: '2026-10-03T19:08:19Z', remainingFraction: 0.75 },
                { bucketId: 'gemini-5h', window: '5h', resetTime: '2026-09-27T00:08:19Z', remainingFraction: 0.9 }
            ]
        },
        {
            displayName: 'Claude and GPT models',
            buckets: [
                { bucketId: '3p-weekly', window: 'weekly', resetTime: '2026-10-02T05:41:46Z', remainingFraction: 0.5 },
                { bucketId: '3p-5h', window: '5h', resetTime: '2026-09-27T00:30:12Z', remainingFraction: 1 }
            ]
        }
    ]
};

const FREE_SUMMARY = {
    groups: [
        {
            displayName: 'Gemini Models',
            buckets: [
                { bucketId: 'gemini-weekly', window: 'weekly', resetTime: '2026-10-03T19:07:49Z', remainingFraction: 0.9992 }
            ]
        },
        {
            displayName: 'Claude and GPT models',
            buckets: [
                { bucketId: '3p-weekly', window: 'weekly', resetTime: '2026-10-03T14:02:18Z', remainingFraction: 1 }
            ]
        }
    ]
};

// fetchAvailableModels 的每模型配额（旧的展示方式）
const MODELS = {
    'gemini-3-flash': { quotaInfo: { remainingFraction: 0.9, resetTime: '2026-09-27T00:08:19Z' } },
    'claude-sonnet-4-6': { quotaInfo: { remainingFraction: 1, resetTime: '2026-09-27T00:30:12Z' } }
};

describe('formatAntigravityUsage', () => {
    test('付费账号：Gemini 与 Claude 各显示 5 小时和周限额', () => {
        const usage = formatAntigravityUsage({
            models: MODELS,
            quotaSummary: PRO_SUMMARY,
            tierId: 'Google AI Pro(free)',
            account: 'user@example.com'
        });

        expect(usage.items.map(i => i.label)).toEqual([
            'Gemini (5h)',
            'Gemini (Weekly)',
            'Claude (5h)',
            'Claude (Weekly)'
        ]);
        expect(usage.items[0].percent).toBeCloseTo(10);
        expect(usage.items[1].percent).toBeCloseTo(25);
        expect(usage.items[3].percent).toBeCloseTo(50);
        expect(usage.items[3].resetAt).toBe('2026-10-02T05:41:46.000Z');
        expect(usage.user.email).toBe('user@example.com');
    });

    test('免费账号：只显示 Gemini 与 Claude 的周限额', () => {
        const usage = formatAntigravityUsage({
            models: MODELS,
            quotaSummary: FREE_SUMMARY,
            tierId: 'Antigravity Starter Quota(free)'
        });

        expect(usage.items.map(i => i.label)).toEqual(['Gemini (Weekly)', 'Claude (Weekly)']);
    });

    test('不再按单个模型拆分显示', () => {
        const usage = formatAntigravityUsage({ models: MODELS, quotaSummary: PRO_SUMMARY });
        expect(usage.items.some(i => i.label.includes('gemini-3-flash'))).toBe(false);
    });

    test('概要显示最紧张的额度', () => {
        const usage = formatAntigravityUsage({ models: MODELS, quotaSummary: PRO_SUMMARY });
        expect(usage.summary.usedPercent).toBeCloseTo(50);
        expect(usage.summary.resetAt).toBe('2026-10-02T05:41:46.000Z');
    });

    test('周限额耗尽时被禁用的 5 小时桶视为用完', () => {
        const usage = formatAntigravityUsage({
            quotaSummary: {
                groups: [{
                    displayName: 'Gemini Models',
                    buckets: [
                        { window: 'weekly', remainingFraction: 0 },
                        { window: '5h', disabled: true, remainingFraction: 1 }
                    ]
                }]
            }
        });
        expect(usage.items.find(i => i.label === 'Gemini (5h)').percent).toBe(100);
    });

    test('拿不到汇总配额时回退到按模型显示', () => {
        const usage = formatAntigravityUsage({ models: MODELS, quotaSummary: null });
        expect(usage.items.map(i => i.id)).toEqual(['gemini-3-flash', 'gemini-claude-sonnet-4-6']);
    });
});
