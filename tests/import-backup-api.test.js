import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { promises as fs } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { Blob } from 'node:buffer';
import { fetch, FormData } from 'undici';
import AdmZip from 'adm-zip';

/**
 * 凭据文件管理里的「导入备份」接口
 *
 * 真的起一个 http 服务、真的传一个 zip 上去、真的检查磁盘上落了什么，
 * 因为这个功能的价值全在「文件到底有没有落到对的位置」。
 */
let workDir;
let originalCwd;
let server;
let baseUrl;
let uploadConfigApi;

/** 把一组 { 路径: 内容 } 打成 zip buffer */
function makeZip(files) {
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(files)) {
        zip.addFile(name, Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)));
    }
    return zip.toBuffer();
}

/**
 * 打一个真带路径穿越条目的 zip
 *
 * AdmZip 的 addFile 会自己把 ../ 洗掉，所以要在打包前直接改 entryName，
 * 否则测的就不是恶意压缩包了。
 */
function makeZipSlipZip(escapeName, safeFiles = {}) {
    const zip = new AdmZip();
    zip.addFile('placeholder.json', Buffer.from('{"evil":true}'));
    zip.getEntries()[0].entryName = escapeName;
    for (const [name, content] of Object.entries(safeFiles)) {
        zip.addFile(name, Buffer.from(JSON.stringify(content)));
    }
    return zip.toBuffer();
}

/** POST 一个备份包到接口 */
async function importBackup(zipBuffer, fields = {}, fileName = 'configs_backup.zip') {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
        form.append(key, String(value));
    }
    form.append('file', new Blob([zipBuffer], { type: 'application/zip' }), fileName);

    const response = await fetch(`${baseUrl}/api/upload-configs/import-backup`, {
        method: 'POST',
        body: form
    });
    return { status: response.status, body: await response.json() };
}

/** 读 configs/ 下的文件，不存在时返回 null */
async function readConfigFile(relative) {
    try {
        return await fs.readFile(path.join(workDir, 'configs', relative), 'utf8');
    } catch {
        return null;
    }
}

beforeAll(async () => {
    originalCwd = process.cwd();
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-import-backup-'));
    await fs.mkdir(path.join(workDir, 'configs'), { recursive: true });

    // 模块里的 configs/ 路径是在 import 时按 cwd 算好的，所以要先 chdir 再 import
    process.chdir(workDir);
    uploadConfigApi = await import('../src/ui-modules/upload-config-api.js');

    server = http.createServer(async (req, res) => {
        await uploadConfigApi.handleImportBackup(req, res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    process.chdir(originalCwd);
    await fs.rm(workDir, { recursive: true, force: true });
});

beforeEach(async () => {
    await fs.rm(path.join(workDir, 'configs'), { recursive: true, force: true });
    await fs.mkdir(path.join(workDir, 'configs'), { recursive: true });
});

describe('POST /api/upload-configs/import-backup', () => {
    test('把「打包下载」导出的包原样还原到各自的位置', async () => {
        const zip = makeZip({
            'config.json': { REQUIRED_API_KEY: 'restored' },
            'provider_pools.json': { 'claude-kiro-oauth': [] },
            'kiro/1700_acct/kiro-auth-token.json': { refreshToken: 'abc' }
        });

        const { status, body } = await importBackup(zip);

        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.importedCount).toBe(3);
        expect(body.failedCount).toBe(0);
        expect(JSON.parse(await readConfigFile('config.json'))).toEqual({ REQUIRED_API_KEY: 'restored' });
        expect(JSON.parse(await readConfigFile('provider_pools.json'))).toEqual({ 'claude-kiro-oauth': [] });
        expect(JSON.parse(await readConfigFile('kiro/1700_acct/kiro-auth-token.json'))).toEqual({ refreshToken: 'abc' });
    });

    test('认得带 configs/ 目录的包，也认得多包了一层的包', async () => {
        const zip = makeZip({
            'AIClient2API-main/configs/config.json': { from: 'wrapped' },
            'AIClient2API-main/src/core/master.js': 'console.log(1)',
            'AIClient2API-main/package.json': { name: 'aiclient2api' }
        });

        const { status, body } = await importBackup(zip);

        expect(status).toBe(200);
        expect(body.style).toBe('configs-dir');
        expect(body.importedCount).toBe(1);
        expect(JSON.parse(await readConfigFile('config.json'))).toEqual({ from: 'wrapped' });
        // configs/ 以外的东西不该被写出来
        expect(await readConfigFile('../src/core/master.js')).toBeNull();
        expect(body.skipped.map(item => item.reason)).toEqual(['outside_configs', 'outside_configs']);
    });

    test('散落在包根目录的凭据被放进对应的提供商目录', async () => {
        const zip = makeZip({
            'kiro-auth-token.json': { refreshToken: 'loose-kiro' },
            'gemini_oauth_creds.json': { access_token: 'loose-gemini' }
        });

        const { status, body } = await importBackup(zip);

        expect(status).toBe(200);
        expect(body.importedCount).toBe(2);

        const routed = body.imported.filter(item => item.routed);
        expect(routed).toHaveLength(2);

        const kiro = body.imported.find(item => item.entry === 'kiro-auth-token.json');
        expect(kiro.provider).toBe('claude-kiro-oauth');
        expect(kiro.target).toMatch(/^configs\/kiro\/\d+_kiro-auth-token\/kiro-auth-token\.json$/);
        expect(await readConfigFile(kiro.target.replace('configs/', ''))).toContain('loose-kiro');

        const gemini = body.imported.find(item => item.entry === 'gemini_oauth_creds.json');
        expect(gemini.target).toBe('configs/gemini/gemini_oauth_creds.json');
        expect(await readConfigFile('gemini/gemini_oauth_creds.json')).toContain('loose-gemini');
    });

    test('默认不覆盖管理密码，勾选之后才恢复', async () => {
        await fs.writeFile(path.join(workDir, 'configs', 'pwd'), 'mypwd');
        const zip = makeZip({ 'pwd': 'theirpwd', 'config.json': {} });

        const first = await importBackup(zip);
        expect(first.body.importedCount).toBe(1);
        expect(first.body.skipped.some(item => item.reason === 'sensitive')).toBe(true);
        expect(await readConfigFile('pwd')).toBe('mypwd');

        const second = await importBackup(zip, { includeSensitive: 'true' });
        expect(second.body.importedCount).toBe(2);
        expect(await readConfigFile('pwd')).toBe('theirpwd');
    });

    test('dryRun 只给计划，不动磁盘', async () => {
        const zip = makeZip({ 'config.json': { should: 'not land' } });

        const { status, body } = await importBackup(zip, { dryRun: 'true' });

        expect(status).toBe(200);
        expect(body.dryRun).toBe(true);
        expect(body.planned).toEqual([
            expect.objectContaining({ entry: 'config.json', target: 'configs/config.json' })
        ]);
        expect(await readConfigFile('config.json')).toBeNull();
        // 也不该留下导入前的快照
        await expect(fs.readdir(path.join(workDir, 'configs', '.backups'))).rejects.toThrow();
    });

    test('导入前会把当前 configs/ 存一份快照', async () => {
        await fs.writeFile(path.join(workDir, 'configs', 'config.json'), '{"old":true}');

        const { body } = await importBackup(makeZip({ 'config.json': { new: true } }));

        expect(body.snapshot).toMatch(/^configs\/\.backups\/pre-import-.*\.zip$/);
        const snapshot = new AdmZip(path.join(workDir, body.snapshot));
        expect(snapshot.readAsText('config.json')).toBe('{"old":true}');
        expect(JSON.parse(await readConfigFile('config.json'))).toEqual({ new: true });
    });

    test('conflictPolicy=skip 保留现有文件', async () => {
        await fs.writeFile(path.join(workDir, 'configs', 'config.json'), '{"mine":true}');

        const { body } = await importBackup(
            makeZip({ 'config.json': { theirs: true } }),
            { conflictPolicy: 'skip' }
        );

        expect(body.importedCount).toBe(0);
        expect(body.skipped.some(item => item.reason === 'exists')).toBe(true);
        expect(JSON.parse(await readConfigFile('config.json'))).toEqual({ mine: true });
    });

    test('conflictPolicy=rename 两份都留着', async () => {
        await fs.writeFile(path.join(workDir, 'configs', 'config.json'), '{"mine":true}');

        const { body } = await importBackup(
            makeZip({ 'config.json': { theirs: true } }),
            { conflictPolicy: 'rename' }
        );

        expect(body.importedCount).toBe(1);
        expect(body.imported[0].target).toMatch(/^configs\/config\.imported-\d+\.json$/);
        expect(JSON.parse(await readConfigFile('config.json'))).toEqual({ mine: true });
        expect(await readConfigFile(body.imported[0].target.replace('configs/', ''))).toContain('theirs');
    });

    test('路径穿越的条目写不出 configs/', async () => {
        const zip = makeZipSlipZip('../../escaped.json', { 'config.json': { ok: true } });

        const { body } = await importBackup(zip);

        expect(body.importedCount).toBe(1);
        expect(body.imported[0].target).toBe('configs/config.json');
        expect(body.skipped).toEqual([
            expect.objectContaining({ entry: '../../escaped.json', reason: 'unsafe_or_ignored' })
        ]);
        await expect(fs.access(path.join(workDir, '..', '..', 'escaped.json'))).rejects.toThrow();
        await expect(fs.access(path.join(workDir, 'escaped.json'))).rejects.toThrow();
    });

    test('随便一个 zip 不会被整包倒进 configs/', async () => {
        const { status, body } = await importBackup(makeZip({
            'src/core/master.js': 'x',
            'README.md': 'hello'
        }));

        expect(status).toBe(400);
        expect(body.error.message).toMatch(/configs backup/);
        expect(body.skipped.map(item => item.reason)).toEqual(['not_a_backup', 'not_a_backup']);
        expect(await readConfigFile('src/core/master.js')).toBeNull();
    });

    test('不是 zip 就直接拒绝', async () => {
        const { status, body } = await importBackup(
            Buffer.from('not a zip at all'),
            {},
            'creds.json'
        );

        expect(status).toBe(400);
        expect(body.error.message).toMatch(/\.zip/);
    });

    test('包里没有任何配置时给出明确的错误', async () => {
        const { status, body } = await importBackup(makeZip({ 'logs/2026-08-27.log': 'x' }));

        expect(status).toBe(400);
        expect(body.error.message).toMatch(/configs backup/);
        expect(body.skipped).toHaveLength(1);
    });

    test('导入完不会把暂存的 zip 留在 configs/temp 里', async () => {
        await importBackup(makeZip({ 'config.json': {} }));

        const leftovers = await fs.readdir(path.join(workDir, 'configs', 'temp')).catch(() => []);
        expect(leftovers.filter(name => name.endsWith('.zip'))).toEqual([]);
    });
});
