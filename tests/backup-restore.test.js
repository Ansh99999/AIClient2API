import { describe, test, expect } from '@jest/globals';
import {
    normalizeEntryName,
    resolveBackupRoot,
    matchProviderByFileName,
    planEntryTarget,
    planRestore,
    looksLikeConfigsEntry,
    ROOT_CONFIG_FILES,
    SENSITIVE_FILES
} from '../src/utils/backup-restore.js';

/**
 * 备份恢复的路径规划逻辑
 *
 * 这里覆盖的是「用户手上那个 zip 长什么样」的各种情况：
 * 「打包下载」导出的包、整个项目目录的包、多包了一层目录的包，
 * 以及恶意构造的路径穿越条目。
 */
describe('normalizeEntryName', () => {
    test('把反斜杠统一成正斜杠', () => {
        expect(normalizeEntryName('kiro\\sub\\creds.json')).toBe('kiro/sub/creds.json');
    });

    test('丢掉目录条目', () => {
        expect(normalizeEntryName('kiro/')).toBeNull();
    });

    test('挡掉路径穿越', () => {
        expect(normalizeEntryName('../../evil.json')).toBeNull();
        expect(normalizeEntryName('kiro/../../evil.json')).toBeNull();
        expect(normalizeEntryName('a/b/../c.json')).toBeNull();
    });

    test('挡掉绝对路径和 Windows 盘符', () => {
        expect(normalizeEntryName('/etc/passwd')).toBeNull();
        expect(normalizeEntryName('C:/Windows/system.ini')).toBeNull();
    });

    test('忽略压缩工具留下的垃圾', () => {
        expect(normalizeEntryName('__MACOSX/._config.json')).toBeNull();
        expect(normalizeEntryName('configs/.DS_Store')).toBeNull();
        expect(normalizeEntryName('configs/Thumbs.db')).toBeNull();
    });

    test('压掉多余的分隔符和 ./', () => {
        expect(normalizeEntryName('./configs//config.json')).toBe('configs/config.json');
    });

    test('空值和非字符串一律拒绝', () => {
        expect(normalizeEntryName('')).toBeNull();
        expect(normalizeEntryName(null)).toBeNull();
        expect(normalizeEntryName(undefined)).toBeNull();
        expect(normalizeEntryName(42)).toBeNull();
    });
});

describe('resolveBackupRoot', () => {
    test('「打包下载」导出的包：条目本身就相对 configs/', () => {
        const result = resolveBackupRoot(['config.json', 'kiro/a/creds.json']);
        expect(result.style).toBe('configs-relative');
        expect(result.entries.map(e => e.relative)).toEqual(['config.json', 'kiro/a/creds.json']);
    });

    test('包里带 configs/ 目录时剥掉这一层', () => {
        const result = resolveBackupRoot(['configs/config.json', 'configs/kiro/a/creds.json']);
        expect(result.style).toBe('configs-dir');
        expect(result.entries.map(e => e.relative)).toEqual(['config.json', 'kiro/a/creds.json']);
    });

    test('多包了一层目录也认得', () => {
        const result = resolveBackupRoot([
            'AIClient2API-main/configs/config.json',
            'AIClient2API-main/configs/gemini/creds.json'
        ]);
        expect(result.style).toBe('configs-dir');
        expect(result.entries.map(e => e.relative)).toEqual(['config.json', 'gemini/creds.json']);
    });

    test('整个项目目录的包：只取 configs/，其余丢掉', () => {
        const result = resolveBackupRoot([
            'configs/config.json',
            'src/core/master.js',
            'logs/2026-08-27.log',
            'package.json'
        ]);
        expect(result.style).toBe('configs-dir');
        expect(result.entries.map(e => e.name)).toEqual(['configs/config.json']);
    });

    test('只有一个名叫 configs 的文件时不会算出空路径', () => {
        const result = resolveBackupRoot(['backup/configs']);
        expect(result.entries).toEqual([]);
    });
});

describe('matchProviderByFileName', () => {
    test('认得 kiro 的固定文件名', () => {
        expect(matchProviderByFileName('kiro-auth-token.json').dirName).toBe('kiro');
    });

    test('从文件名里的提供商名字认出目录', () => {
        expect(matchProviderByFileName('1700000000_kiro_oauth_creds.json').dirName).toBe('kiro');
        expect(matchProviderByFileName('gemini_oauth_creds.json').dirName).toBe('gemini');
        expect(matchProviderByFileName('antigravity_oauth_creds.json').dirName).toBe('antigravity');
    });

    test('grok-cli 不会被 grok 抢走', () => {
        expect(matchProviderByFileName('grok-cli_oauth_creds.json').dirName).toBe('grok-cli');
        expect(matchProviderByFileName('grok_cookie.json').dirName).toBe('grok');
    });

    test('认不出来就返回 null', () => {
        expect(matchProviderByFileName('something-else.json')).toBeNull();
    });
});

describe('planEntryTarget', () => {
    test('带目录的条目原样落回去', () => {
        expect(planEntryTarget('kiro/1700_acct/creds.json')).toEqual({
            target: 'kiro/1700_acct/creds.json',
            routed: false,
            provider: null
        });
    });

    test('根目录的配置文件留在根目录', () => {
        for (const name of ROOT_CONFIG_FILES) {
            expect(planEntryTarget(name).target).toBe(name);
            expect(planEntryTarget(name).routed).toBe(false);
        }
    });

    test('*.example 模板也留在根目录', () => {
        expect(planEntryTarget('provider_pools.json.example').target).toBe('provider_pools.json.example');
    });

    test('散落的 kiro 凭据会单独包一层目录', () => {
        const result = planEntryTarget('kiro-auth-token.json', { now: 1700000000000 });
        expect(result.target).toBe('kiro/1700000000000_kiro-auth-token/kiro-auth-token.json');
        expect(result.routed).toBe(true);
        expect(result.provider).toBe('claude-kiro-oauth');
    });

    test('散落的其他凭据放进对应的提供商目录', () => {
        const result = planEntryTarget('gemini_oauth_creds.json');
        expect(result.target).toBe('gemini/gemini_oauth_creds.json');
        expect(result.routed).toBe(true);
        expect(result.provider).toBe('gemini-cli-oauth');
    });

    test('认不出来的散落文件留在 configs/ 根目录', () => {
        const result = planEntryTarget('mystery.json');
        expect(result).toEqual({ target: 'mystery.json', routed: false, provider: null });
    });
});

describe('planRestore', () => {
    test('每个落点都在 configs/ 底下', () => {
        const plan = planRestore(['config.json', 'kiro/a/creds.json', 'gemini_oauth_creds.json']);
        expect(plan.planned.map(p => p.target)).toEqual([
            'configs/config.json',
            'configs/kiro/a/creds.json',
            'configs/gemini/gemini_oauth_creds.json'
        ]);
    });

    test('默认不恢复管理密码和登录会话', () => {
        const plan = planRestore(['config.json', ...SENSITIVE_FILES]);
        expect(plan.planned.map(p => p.target)).toEqual(['configs/config.json']);
        expect(plan.skipped.map(s => s.reason)).toEqual(['sensitive', 'sensitive']);
    });

    test('勾选之后才恢复敏感文件', () => {
        const plan = planRestore(['pwd', 'token-store.json'], { includeSensitive: true });
        expect(plan.planned.map(p => p.target)).toEqual(['configs/pwd', 'configs/token-store.json']);
        expect(plan.skipped).toEqual([]);
    });

    test('不恢复临时目录和历史快照', () => {
        const plan = planRestore([
            'config.json',
            'temp/1700_upload.json',
            '.backups/pre-import-2026-08-27.zip'
        ]);
        expect(plan.planned.map(p => p.target)).toEqual(['configs/config.json']);
        expect(plan.skipped.map(s => s.reason)).toEqual(['excluded_dir', 'excluded_dir']);
    });

    test('路径穿越的条目进不了计划', () => {
        const plan = planRestore(['../../evil.json', 'config.json']);
        expect(plan.planned.map(p => p.target)).toEqual(['configs/config.json']);
        expect(plan.skipped[0]).toEqual({ entry: '../../evil.json', reason: 'unsafe_or_ignored' });
    });

    test('落点撞车时只留第一个', () => {
        const plan = planRestore(['configs/config.json', 'other/configs/config.json']);
        expect(plan.planned).toHaveLength(1);
        expect(plan.skipped.map(s => s.reason)).toContain('duplicate_target');
    });

    test('整个项目目录的包只恢复 configs/ 里的东西', () => {
        const plan = planRestore([
            'configs/config.json',
            'configs/provider_pools.json',
            'src/core/master.js',
            'node_modules/adm-zip/package.json'
        ]);
        expect(plan.planned.map(p => p.target)).toEqual([
            'configs/config.json',
            'configs/provider_pools.json'
        ]);
        expect(plan.skipped.map(s => s.reason)).toEqual(['outside_configs', 'outside_configs']);
    });

    test('空包给出空计划而不是抛错', () => {
        expect(planRestore([])).toEqual({ style: 'configs-relative', planned: [], skipped: [] });
    });

    test('压缩包里认不出任何配置时整包拒绝', () => {
        const plan = planRestore(['src/core/master.js', 'README.md']);
        expect(plan.planned).toEqual([]);
        expect(plan.skipped.map(s => s.reason)).toEqual(['not_a_backup', 'not_a_backup']);
    });

    test('带 configs/ 目录的包不需要再猜，直接认', () => {
        const plan = planRestore(['configs/whatever-i-put-here.txt']);
        expect(plan.planned.map(p => p.target)).toEqual(['configs/whatever-i-put-here.txt']);
    });

    test('只要有一个条目认得出来，同包的其他文件也一起恢复', () => {
        const plan = planRestore(['config.json', 'my-notes.txt']);
        expect(plan.planned.map(p => p.target)).toEqual([
            'configs/config.json',
            'configs/my-notes.txt'
        ]);
    });
});

describe('looksLikeConfigsEntry', () => {
    test('认得根目录的配置文件和模板', () => {
        expect(looksLikeConfigsEntry('config.json')).toBe(true);
        expect(looksLikeConfigsEntry('provider_pools.json.example')).toBe(true);
    });

    test('认得提供商目录', () => {
        expect(looksLikeConfigsEntry('kiro/a/creds.json')).toBe(true);
        expect(looksLikeConfigsEntry('grok-cli/token.json')).toBe(true);
    });

    test('认得散落的凭据文件', () => {
        expect(looksLikeConfigsEntry('kiro-auth-token.json')).toBe(true);
    });

    test('项目代码和日志不算', () => {
        expect(looksLikeConfigsEntry('src/core/master.js')).toBe(false);
        expect(looksLikeConfigsEntry('README.md')).toBe(false);
        expect(looksLikeConfigsEntry('logs/2026-08-27.log')).toBe(false);
    });
});
