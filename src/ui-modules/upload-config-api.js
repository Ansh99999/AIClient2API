import { existsSync } from 'fs';
import logger from '../utils/logger.js';
import { promises as fs } from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import multer from 'multer';
import { broadcastEvent } from './event-broadcast.js';
import { scanConfigFiles } from './config-scanner.js';
import { atomicWriteFile } from '../utils/file-lock.js';
import {
    planRestore,
    EXCLUDED_CONFIG_DIRS,
    MAX_BACKUP_ENTRIES,
    MAX_BACKUP_BYTES,
    MAX_BACKUP_UPLOAD_BYTES
} from '../utils/backup-restore.js';

/** 导入备份时的暂存目录（和单文件上传共用） */
const BACKUP_STAGING_DIR = path.join(process.cwd(), 'configs', 'temp');

/** 导入前的自动快照存放目录，放在 configs/ 里才能在版本更新时被保留 */
const SNAPSHOT_DIR = path.join(process.cwd(), 'configs', '.backups');

/** 自动快照保留份数 */
const MAX_SNAPSHOTS = 5;

/**
 * 递归把目录加进 zip
 * @param {AdmZip} zip - 目标压缩包
 * @param {string} dirPath - 要打包的目录
 * @param {string} zipPath - 压缩包内的相对路径
 * @param {string[]} excludeNames - 需要跳过的条目名（只在顶层生效）
 */
async function addDirectoryToZip(zip, dirPath, zipPath = '', excludeNames = []) {
    const items = await fs.readdir(dirPath, { withFileTypes: true });
    for (const item of items) {
        if (!zipPath && excludeNames.includes(item.name)) continue;

        const fullPath = path.join(dirPath, item.name);
        const itemZipPath = zipPath ? path.join(zipPath, item.name) : item.name;

        if (item.isFile()) {
            const content = await fs.readFile(fullPath);
            zip.addFile(itemZipPath.replace(/\\/g, '/'), content);
        } else if (item.isDirectory()) {
            await addDirectoryToZip(zip, fullPath, itemZipPath, excludeNames);
        }
    }
}

/**
 * 写一个 JSON 响应
 */
function sendJson(res, statusCode, body) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

/**
 * 获取上传配置文件列表
 */
export async function handleGetUploadConfigs(req, res, currentConfig, providerPoolManager) {
    try {
        const configFiles = await scanConfigFiles(currentConfig, providerPoolManager);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(configFiles));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to scan config files:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to scan config files: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 查看特定配置文件
 */
export async function handleViewConfigFile(req, res, filePath) {
    try {
        const fullPath = path.join(process.cwd(), filePath);
        
        // 安全检查：确保文件路径在允许的目录内
        const allowedDirs = ['configs'];
        const relativePath = path.relative(process.cwd(), fullPath);
        const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
        
        if (!isAllowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Access denied: can only view files in configs directory'
                }
            }));
            return true;
        }
        
        if (!existsSync(fullPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'File does not exist'
                }
            }));
            return true;
        }
        
        const content = await fs.readFile(fullPath, 'utf-8');
        const stats = await fs.stat(fullPath);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            path: relativePath,
            content: content,
            size: stats.size,
            modified: stats.mtime.toISOString(),
            name: path.basename(fullPath)
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to view config file:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to view config file: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 下载特定配置文件
 */
export async function handleDownloadConfigFile(req, res, filePath) {
    try {
        const fullPath = path.join(process.cwd(), filePath);
        
        // 安全检查：确保文件路径在允许的目录内
        const allowedDirs = ['configs'];
        const relativePath = path.relative(process.cwd(), fullPath);
        const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
        
        if (!isAllowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Access denied: can only download files in configs directory'
                }
            }));
            return true;
        }
        
        if (!existsSync(fullPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'File does not exist'
                }
            }));
            return true;
        }
        
        const content = await fs.readFile(fullPath);
        const fileName = path.basename(fullPath);
        
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${fileName}"`,
            'Content-Length': content.length
        });
        res.end(content);
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to download config file:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to download config file: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 删除特定配置文件
 */
export async function handleDeleteConfigFile(req, res, filePath) {
    try {
        const fullPath = path.join(process.cwd(), filePath);
        
        // 安全检查：确保文件路径在允许的目录内
        const allowedDirs = ['configs'];
        const relativePath = path.relative(process.cwd(), fullPath);
        const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
        
        if (!isAllowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Access denied: can only delete files in configs directory'
                }
            }));
            return true;
        }
        
        if (!existsSync(fullPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'File does not exist'
                }
            }));
            return true;
        }
        
        
        await fs.unlink(fullPath);
        
        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'delete',
            filePath: relativePath,
            timestamp: new Date().toISOString()
        });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'File deleted successfully',
            filePath: relativePath
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to delete config file:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to delete config file: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 下载所有配置为 zip
 */
export async function handleDownloadAllConfigs(req, res) {
    try {
        const configsPath = path.join(process.cwd(), 'configs');
        if (!existsSync(configsPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'configs directory does not exist' } }));
            return true;
        }

        const zip = new AdmZip();

        // 跳过 temp（上传暂存）和 .backups（导入前的自动快照），
        // 否则备份包会一层套一层地把历史快照全带上
        await addDirectoryToZip(zip, configsPath, '', EXCLUDED_CONFIG_DIRS);
        
        const zipBuffer = zip.toBuffer();
        const filename = `configs_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;

        res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': zipBuffer.length
        });
        res.end(zipBuffer);
        
        logger.info(`[UI API] All configs downloaded as zip: ${filename}`);
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to download all configs:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to download zip: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 批量删除未绑定的配置文件
 * 只删除 configs/xxx/ 子目录下的未绑定配置文件
 */
export async function handleDeleteUnboundConfigs(req, res, currentConfig, providerPoolManager) {
    try {
        // 首先获取所有配置文件及其绑定状态
        const configFiles = await scanConfigFiles(currentConfig, providerPoolManager);
        
        // 筛选出未绑定的配置文件，并且必须在 configs/xxx/ 子目录下
        // 即路径格式为 configs/子目录名/文件名，而不是直接在 configs/ 根目录下
        const unboundConfigs = configFiles.filter(config => {
            if (config.isUsed) return false;
            
            // 检查路径是否在 configs/xxx/ 子目录下
            // 路径格式应该是 configs/子目录/...
            const normalizedPath = config.path.replace(/\\/g, '/');
            const pathParts = normalizedPath.split('/');
            
            // 路径至少需要3部分：configs/子目录/文件名
            // 例如：configs/kiro/xxx.json 或 configs/gemini/xxx.json
            if (pathParts.length >= 3 && pathParts[0] === 'configs') {
                // 确保第二部分是子目录名（不是文件名）
                return true;
            }
            
            return false;
        });
        
        if (unboundConfigs.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'No unbound config files to delete',
                deletedCount: 0,
                deletedFiles: []
            }));
            return true;
        }
        
        const deletedFiles = [];
        const failedFiles = [];
        
        for (const config of unboundConfigs) {
            try {
                const fullPath = path.join(process.cwd(), config.path);
                
                // 安全检查：确保文件路径在允许的目录内
                const allowedDirs = ['configs'];
                const relativePath = path.relative(process.cwd(), fullPath);
                const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
                
                if (!isAllowed) {
                    failedFiles.push({
                        path: config.path,
                        error: 'Access denied: can only delete files in configs directory'
                    });
                    continue;
                }
                
                if (!existsSync(fullPath)) {
                    failedFiles.push({
                        path: config.path,
                        error: 'File does not exist'
                    });
                    continue;
                }
                
                await fs.unlink(fullPath);
                deletedFiles.push(config.path);
                
            } catch (error) {
                failedFiles.push({
                    path: config.path,
                    error: error.message
                });
            }
        }
        
        // 广播更新事件
        if (deletedFiles.length > 0) {
            broadcastEvent('config_update', {
                action: 'batch_delete',
                deletedFiles: deletedFiles,
                timestamp: new Date().toISOString()
            });
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Deleted ${deletedFiles.length} unbound config files`,
            deletedCount: deletedFiles.length,
            deletedFiles: deletedFiles,
            failedCount: failedFiles.length,
            failedFiles: failedFiles
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to delete unbound configs:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to delete unbound configs: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 强制触发凭据关联节点的令牌刷新
 */
export async function handleForceExpireConfig(req, res, filePath, currentConfig, providerPoolManager) {
    try {
        const fullPath = path.join(process.cwd(), filePath);
        
        // 安全检查：确保文件路径在允许的目录内
        const allowedDirs = ['configs'];
        const relativePath = path.relative(process.cwd(), fullPath);
        const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
        
        if (!isAllowed) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Access denied: can only access files in configs directory'
                }
            }));
            return true;
        }
        
        if (!existsSync(fullPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'File does not exist'
                }
            }));
            return true;
        }

        // 触发即时刷新逻辑
        let refreshCount = 0;
        if (providerPoolManager) {
            const configFiles = await scanConfigFiles(currentConfig, providerPoolManager);
            const targetFile = configFiles.find(f => f.path === relativePath || f.path === filePath);
            
            if (targetFile && targetFile.usageInfo && targetFile.usageInfo.isUsed && Array.isArray(targetFile.usageInfo.usageDetails)) {
                for (const usage of targetFile.usageInfo.usageDetails) {
                    if (usage.uuid && usage.providerType) {
                        // 强制触发刷新
                        const success = await providerPoolManager.refreshNode(usage.providerType, usage.uuid, true);
                        if (success) refreshCount++;
                    }
                }
            }
        }
        
        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'force_refresh',
            filePath: relativePath,
            refreshTriggered: refreshCount > 0,
            refreshCount: refreshCount,
            timestamp: new Date().toISOString()
        });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: refreshCount > 0 ? `Triggered refresh for ${refreshCount} node(s)` : 'No active nodes found for this credential',
            filePath: relativePath,
            refreshTriggered: refreshCount > 0
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to force refresh config:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to force refresh config: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 备份包上传：只收 .zip，先落到 configs/temp 再解析
 */
const backupUpload = multer({
    storage: multer.diskStorage({
        destination: async (req, file, cb) => {
            try {
                await fs.mkdir(BACKUP_STAGING_DIR, { recursive: true });
                cb(null, BACKUP_STAGING_DIR);
            } catch (error) {
                cb(error);
            }
        },
        filename: (req, file, cb) => cb(null, `${Date.now()}_import_backup.zip`)
    }),
    fileFilter: (req, file, cb) => {
        if (path.extname(file.originalname).toLowerCase() === '.zip') {
            cb(null, true);
        } else {
            cb(new Error('Backup must be a .zip archive'), false);
        }
    },
    limits: { fileSize: MAX_BACKUP_UPLOAD_BYTES }
});

/**
 * 只保留最近 MAX_SNAPSHOTS 份自动快照
 */
async function pruneSnapshots() {
    try {
        const names = (await fs.readdir(SNAPSHOT_DIR))
            .filter(name => name.startsWith('pre-import-') && name.endsWith('.zip'))
            // ISO 时间戳的字典序就是时间序
            .sort()
            .reverse();

        for (const name of names.slice(MAX_SNAPSHOTS)) {
            await fs.unlink(path.join(SNAPSHOT_DIR, name)).catch(() => {});
        }
    } catch (error) {
        logger.warn('[UI API] Failed to prune pre-import snapshots:', error.message);
    }
}
/**
 * 导入前给当前 configs/ 打一份快照，导错了还能捞回来
 * @returns {Promise<string|null>} 快照的相对路径，configs/ 为空时返回 null
 */
async function createConfigsSnapshot() {
    const configsPath = path.join(process.cwd(), 'configs');
    if (!existsSync(configsPath)) return null;

    const zip = new AdmZip();
    await addDirectoryToZip(zip, configsPath, '', EXCLUDED_CONFIG_DIRS);
    if (zip.getEntries().length === 0) return null;

    await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
    const fileName = `pre-import-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
    const fullPath = path.join(SNAPSHOT_DIR, fileName);
    await fs.writeFile(fullPath, zip.toBuffer());
    await pruneSnapshots();

    return path.relative(process.cwd(), fullPath).replace(/\\/g, '/');
}

/**
 * 给重名文件加个后缀，用于 conflictPolicy = rename
 */
function withImportedSuffix(absolutePath, stamp) {
    const dir = path.dirname(absolutePath);
    const ext = path.extname(absolutePath);
    const stem = path.basename(absolutePath, ext);
    return path.join(dir, `${stem}.imported-${stamp}${ext}`);
}
/**
 * 导入备份包，把整份配置还原到各自的位置
 *
 * 认「打包下载」导出的包，也认任何带 configs/ 目录的压缩包
 * （整个项目目录的压缩包、多包了一层目录的压缩包都行）。
 * 散落在包根目录的凭据文件会按文件名认出提供商，放进对应的子目录。
 *
 * multipart 字段：
 * - file：备份 zip
 * - dryRun：'true' 时只返回恢复计划，不落盘
 * - includeSensitive：'true' 时连 pwd / token-store.json 一起恢复
 * - conflictPolicy：overwrite（默认）/ skip / rename
 */
export async function handleImportBackup(req, res) {
    return new Promise((resolve) => {
        backupUpload.single('file')(req, res, async (err) => {
            const stagedPath = req.file?.path || null;

            try {
                if (err) {
                    sendJson(res, 400, { error: { message: err.message || 'Backup upload failed' } });
                    return;
                }
                if (!req.file) {
                    sendJson(res, 400, { error: { message: 'No backup archive was uploaded' } });
                    return;
                }

                const dryRun = String(req.body?.dryRun ?? 'false') === 'true';
                const includeSensitive = String(req.body?.includeSensitive ?? 'false') === 'true';
                const conflictPolicy = ['overwrite', 'skip', 'rename'].includes(req.body?.conflictPolicy)
                    ? req.body.conflictPolicy
                    : 'overwrite';

                let zip;
                try {
                    zip = new AdmZip(stagedPath);
                } catch (zipError) {
                    sendJson(res, 400, {
                        error: { message: 'Not a readable zip archive: ' + zipError.message }
                    });
                    return;
                }
                const fileEntries = zip.getEntries().filter(entry => !entry.isDirectory);
                if (fileEntries.length === 0) {
                    sendJson(res, 400, { error: { message: 'The backup archive is empty' } });
                    return;
                }
                if (fileEntries.length > MAX_BACKUP_ENTRIES) {
                    sendJson(res, 400, {
                        error: { message: `Too many entries in the archive (limit ${MAX_BACKUP_ENTRIES})` }
                    });
                    return;
                }

                // 防压缩炸弹：先看声明的解压后大小，再决定要不要读
                const totalBytes = fileEntries.reduce((sum, entry) => sum + (entry.header?.size || 0), 0);
                if (totalBytes > MAX_BACKUP_BYTES) {
                    sendJson(res, 400, {
                        error: { message: `Uncompressed size exceeds the limit of ${MAX_BACKUP_BYTES} bytes` }
                    });
                    return;
                }

                const plan = planRestore(fileEntries.map(entry => entry.entryName), { includeSensitive });

                if (plan.planned.length === 0) {
                    sendJson(res, 400, {
                        error: { message: 'Nothing in this archive looks like a configs backup' },
                        style: plan.style,
                        skipped: plan.skipped
                    });
                    return;
                }

                if (dryRun) {
                    sendJson(res, 200, {
                        success: true,
                        dryRun: true,
                        style: plan.style,
                        archive: req.file.originalname,
                        totalBytes,
                        plannedCount: plan.planned.length,
                        skippedCount: plan.skipped.length,
                        planned: plan.planned,
                        skipped: plan.skipped
                    });
                    return;
                }
                const snapshot = await createConfigsSnapshot();

                const entryByName = new Map(fileEntries.map(entry => [entry.entryName, entry]));
                const configsRoot = path.resolve(process.cwd(), 'configs');
                const stamp = Date.now();

                const imported = [];
                const skipped = [...plan.skipped];
                const failed = [];

                for (const item of plan.planned) {
                    try {
                        const entry = entryByName.get(item.entry);
                        if (!entry) {
                            failed.push({ target: item.target, error: 'Entry vanished from the archive' });
                            continue;
                        }

                        let absoluteTarget = path.resolve(process.cwd(), item.target);

                        // 二次兜底：不管计划算出什么，都必须落在 configs/ 里
                        const relativeToConfigs = path.relative(configsRoot, absoluteTarget);
                        if (path.isAbsolute(relativeToConfigs) || relativeToConfigs.startsWith('..')) {
                            failed.push({ target: item.target, error: 'Target directory escape detected' });
                            continue;
                        }

                        if (existsSync(absoluteTarget)) {
                            if (conflictPolicy === 'skip') {
                                skipped.push({ entry: item.entry, target: item.target, reason: 'exists' });
                                continue;
                            }
                            if (conflictPolicy === 'rename') {
                                absoluteTarget = withImportedSuffix(absoluteTarget, stamp);
                            }
                        }

                        await fs.mkdir(path.dirname(absoluteTarget), { recursive: true });
                        await atomicWriteFile(absoluteTarget, entry.getData());

                        imported.push({
                            entry: item.entry,
                            target: path.relative(process.cwd(), absoluteTarget).replace(/\\/g, '/'),
                            routed: item.routed,
                            provider: item.provider
                        });
                    } catch (itemError) {
                        failed.push({ target: item.target, error: itemError.message });
                    }
                }
                if (imported.length > 0) {
                    broadcastEvent('config_update', {
                        action: 'import_backup',
                        importedCount: imported.length,
                        timestamp: new Date().toISOString()
                    });
                }

                logger.info(`[UI API] Backup imported from ${req.file.originalname}: ${imported.length} restored, ${skipped.length} skipped, ${failed.length} failed`);

                sendJson(res, 200, {
                    success: failed.length === 0,
                    style: plan.style,
                    archive: req.file.originalname,
                    snapshot,
                    conflictPolicy,
                    includeSensitive,
                    importedCount: imported.length,
                    skippedCount: skipped.length,
                    failedCount: failed.length,
                    imported,
                    skipped,
                    failed,
                    // 恢复出来的 config.json / provider_pools.json 要重载一次才生效
                    reloadRecommended: imported.length > 0
                });
            } catch (error) {
                logger.error('[UI API] Failed to import backup:', error);
                sendJson(res, 500, { error: { message: 'Failed to import backup: ' + error.message } });
            } finally {
                // 暂存的 zip 不留在 configs/temp 里，否则会被下一次打包带上
                if (stagedPath && existsSync(stagedPath)) {
                    await fs.unlink(stagedPath).catch(() => {});
                }
                resolve(true);
            }
        });
    });
}
