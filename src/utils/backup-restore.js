/**
 * 备份恢复工具模块
 *
 * 这里只做「压缩包条目名 -> configs/ 下的目标路径」这一件事，全部是纯函数，
 * 真正的读写留给 ui-modules/upload-config-api.js，方便单测覆盖各种备份包结构。
 */

import { PROVIDER_MAPPINGS } from './provider-utils.js';

/**
 * configs/ 根目录下认得的配置文件：这些文件本来就该待在根目录，
 * 不要被下面的提供商路由逻辑挪进子目录。
 */
export const ROOT_CONFIG_FILES = [
    'config.json',
    'provider_pools.json',
    'provider-pools.json',
    'custom_models.json',
    'plugins.json',
    'market.json',
    'pwd',
    'token-store.json',
    'usage-cache.json',
    'model-usage-stats.json',
    'api-potluck-keys.json',
    'api-potluck-data.json',
    'fetch_system_prompt.txt',
    'input_system_prompt.txt'
];

/**
 * 需要用户显式勾选才恢复的文件：
 * pwd 是管理后台密码，token-store.json 是登录会话，
 * 默认跳过，免得导入别人机器上的备份之后自己反而登不进来。
 */
export const SENSITIVE_FILES = ['pwd', 'token-store.json'];

/** 压缩包条目数量上限 */
export const MAX_BACKUP_ENTRIES = 5000;

/** 解压后总字节数上限（防压缩炸弹） */
export const MAX_BACKUP_BYTES = 512 * 1024 * 1024;

/** 上传的备份包本身的大小上限 */
export const MAX_BACKUP_UPLOAD_BYTES = 200 * 1024 * 1024;

/** 压缩工具留下的垃圾文件，直接忽略 */
const JUNK_BASENAMES = ['.ds_store', 'thumbs.db', 'desktop.ini'];

/** 打包/恢复时都要跳过的 configs/ 下的目录 */
export const EXCLUDED_CONFIG_DIRS = ['.backups', 'temp'];

/**
 * 规范化压缩包里的条目名，同时挡掉路径穿越
 * @param {string} name - 压缩包内的原始条目名
 * @returns {string|null} 用正斜杠分隔的相对路径，不可用时返回 null
 */
export function normalizeEntryName(name) {
    if (typeof name !== 'string' || name.length === 0) return null;

    const unified = name.replace(/\\/g, '/');

    // 目录条目：目录会在写文件时按需创建，不用单独处理
    if (unified.endsWith('/')) return null;

    // 绝对路径和 Windows 盘符一律拒绝
    if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) return null;

    const segments = [];
    for (const segment of unified.split('/')) {
        if (segment === '' || segment === '.') continue;
        // zip-slip：出现 .. 就整条丢掉，不做任何「聪明」的修正
        if (segment === '..') return null;
        segments.push(segment);
    }
    if (segments.length === 0) return null;

    if (segments[0] === '__MACOSX') return null;

    const base = segments[segments.length - 1];
    if (JUNK_BASENAMES.includes(base.toLowerCase())) return null;

    return segments.join('/');
}

/**
 * 判断备份包的结构，把条目名换算成相对 configs/ 的路径
 *
 * 认两种结构：
 * - configs-dir：包里带着 configs/ 目录（例如整个项目目录的压缩包，
 *   或 `AIClient2API-main/configs/...` 这种多包了一层的），只取 configs/ 里的东西；
 * - configs-relative：条目本身就是相对 configs/ 的（「打包下载」导出的就是这种）。
 *
 * @param {string[]} names - 已经过 normalizeEntryName 的条目名
 * @returns {{style: string, entries: Array<{name: string, relative: string}>}}
 */
export function resolveBackupRoot(names) {
    const hasConfigsDir = names.some(name => name.split('/').includes('configs'));

    if (hasConfigsDir) {
        const entries = [];
        for (const name of names) {
            const segments = name.split('/');
            // 取最外层的 configs 作为根
            const index = segments.indexOf('configs');
            if (index === -1) continue;
            const relative = segments.slice(index + 1).join('/');
            if (!relative) continue;
            entries.push({ name, relative });
        }
        return { style: 'configs-dir', entries };
    }

    return {
        style: 'configs-relative',
        entries: names.map(name => ({ name, relative: name }))
    };
}

/**
 * 按文件名认出提供商
 *
 * PROVIDER_MAPPINGS 里的 patterns 是按路径写的（`/kiro/` 之类），
 * 散落在备份包根目录的凭据文件只有文件名可用，所以这里单独处理。
 *
 * @param {string} fileName - 文件名（不含目录）
 * @param {Array} mappings - 提供商映射表
 * @returns {Object|null} 命中的映射，认不出来返回 null
 */
export function matchProviderByFileName(fileName, mappings = PROVIDER_MAPPINGS) {
    const lower = fileName.toLowerCase();

    // 先试不带斜杠的 pattern，例如 kiro-auth-token
    for (const mapping of mappings) {
        for (const pattern of mapping.patterns) {
            if (!pattern.includes('/') && lower.includes(pattern)) return mapping;
        }
    }

    // 再退回目录名匹配。长目录名优先，否则 grok 会抢走 grok-cli 的文件
    const byNameLength = [...mappings].sort((a, b) => b.dirName.length - a.dirName.length);
    for (const mapping of byNameLength) {
        if (lower.includes(mapping.dirName)) return mapping;
    }

    return null;
}

/**
 * 算出单个条目该落到 configs/ 下的哪里
 * @param {string} relative - 相对 configs/ 的路径
 * @param {Object} [options]
 * @param {number} [options.now] - 时间戳，用于 kiro 凭据的独立目录名
 * @param {Array} [options.providerMappings] - 提供商映射表
 * @returns {{target: string, routed: boolean, provider: string|null}}
 */
export function planEntryTarget(relative, options = {}) {
    const { now = Date.now(), providerMappings = PROVIDER_MAPPINGS } = options;

    const segments = relative.split('/');
    const base = segments[segments.length - 1];

    // 备份包自己的目录结构就是「各自的位置」，带目录的条目原样落回去
    if (segments.length > 1) {
        return { target: relative, routed: false, provider: null };
    }

    // configs/ 根目录本来就有的文件（以及 *.example 模板）留在根目录
    if (ROOT_CONFIG_FILES.includes(base.toLowerCase()) || base.toLowerCase().endsWith('.example')) {
        return { target: base, routed: false, provider: null };
    }

    const mapping = matchProviderByFileName(base, providerMappings);
    if (!mapping) {
        return { target: base, routed: false, provider: null };
    }

    if (mapping.dirName === 'kiro') {
        // kiro 的每份凭据都要单独包一层目录，和单文件上传的规则保持一致
        const stem = base.replace(/\.[^.]*$/, '');
        return {
            target: `kiro/${now}_${stem}/${base}`,
            routed: true,
            provider: mapping.providerType
        };
    }

    return {
        target: `${mapping.dirName}/${base}`,
        routed: true,
        provider: mapping.providerType
    };
}

/**
 * 这个条目看起来像 configs/ 里的东西吗？
 *
 * 只在包里没有 configs/ 目录时用来判断「这压缩包到底是不是一份配置备份」，
 * 免得随便一个 zip 被整包倒进 configs/。
 *
 * @param {string} relative - 相对 configs/ 的路径
 * @param {Array} mappings - 提供商映射表
 * @returns {boolean}
 */
export function looksLikeConfigsEntry(relative, mappings = PROVIDER_MAPPINGS) {
    const segments = relative.split('/');
    const base = segments[segments.length - 1].toLowerCase();
    const top = segments[0];

    if (ROOT_CONFIG_FILES.includes(base) || base.endsWith('.example')) return true;
    if (mappings.some(mapping => mapping.dirName === top)) return true;
    if (EXCLUDED_CONFIG_DIRS.includes(top)) return true;

    return matchProviderByFileName(base, mappings) !== null;
}

/**
 * 把整个压缩包的条目名规划成一份恢复计划
 *
 * @param {string[]} entryNames - 压缩包内所有文件条目名
 * @param {Object} [options]
 * @param {boolean} [options.includeSensitive] - 是否恢复 pwd / token-store.json
 * @param {number} [options.now] - 时间戳
 * @param {Array} [options.providerMappings] - 提供商映射表
 * @returns {{style: string, planned: Array, skipped: Array}}
 */
export function planRestore(entryNames, options = {}) {
    const { includeSensitive = false, providerMappings = PROVIDER_MAPPINGS } = options;

    const skipped = [];
    const normalized = [];

    for (const raw of entryNames) {
        const name = normalizeEntryName(raw);
        if (!name) {
            skipped.push({ entry: String(raw), reason: 'unsafe_or_ignored' });
            continue;
        }
        normalized.push(name);
    }

    const { style, entries } = resolveBackupRoot(normalized);

    // 整个项目目录的压缩包里还有 src/、logs/ 之类，这些不属于配置，报出来但不恢复
    const kept = new Set(entries.map(entry => entry.name));
    for (const name of normalized) {
        if (!kept.has(name)) skipped.push({ entry: name, reason: 'outside_configs' });
    }

    // 包里没有 configs/ 目录时，至少要有一个条目认得出来，否则这就不是一份配置备份
    if (style === 'configs-relative' && entries.length > 0
        && !entries.some(entry => looksLikeConfigsEntry(entry.relative, providerMappings))) {
        return {
            style,
            planned: [],
            skipped: [...skipped, ...entries.map(entry => ({ entry: entry.name, reason: 'not_a_backup' }))]
        };
    }

    const planned = [];
    const takenTargets = new Set();

    for (const entry of entries) {
        const base = entry.relative.split('/').pop();

        const topSegment = entry.relative.split('/')[0];
        if (entry.relative.includes('/') && EXCLUDED_CONFIG_DIRS.includes(topSegment)) {
            skipped.push({ entry: entry.name, reason: 'excluded_dir' });
            continue;
        }

        if (!includeSensitive && SENSITIVE_FILES.includes(base.toLowerCase())) {
            skipped.push({ entry: entry.name, reason: 'sensitive' });
            continue;
        }

        const { target, routed, provider } = planEntryTarget(entry.relative, options);

        // 两个条目撞到同一个目标：留第一个，后面的报出来
        if (takenTargets.has(target)) {
            skipped.push({ entry: entry.name, reason: 'duplicate_target' });
            continue;
        }
        takenTargets.add(target);

        planned.push({
            entry: entry.name,
            relative: entry.relative,
            target: `configs/${target}`,
            routed,
            provider
        });
    }

    return { style, planned, skipped };
}
