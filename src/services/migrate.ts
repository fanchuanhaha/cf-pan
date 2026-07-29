// 彩虹外链网盘 - 存储迁移服务
// 用于在不同存储后端之间迁移文件

import type { IStorage } from '../storage/IStorage';

export type MigrationMode = 'copy' | 'new' | 'switch';

export interface MigrationProgress {
  total: number;
  processed: number;
  success: number;
  failed: number;
  currentFile: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  errors: string[];
  startTime: number;
  endTime?: number;
}

// 内存中的迁移任务状态（Worker 实例级别）
const migrationTasks: Map<string, MigrationProgress> = new Map();

/** 创建迁移任务 */
export function createMigrationTask(taskId: string): MigrationProgress {
  const task: MigrationProgress = {
    total: 0,
    processed: 0,
    success: 0,
    failed: 0,
    currentFile: '',
    status: 'running',
    errors: [],
    startTime: Date.now(),
  };
  migrationTasks.set(taskId, task);
  return task;
}

/** 获取迁移任务状态 */
export function getMigrationStatus(taskId: string): MigrationProgress | null {
  return migrationTasks.get(taskId) || null;
}

/** 取消迁移任务 */
export function cancelMigration(taskId: string): void {
  const task = migrationTasks.get(taskId);
  if (task && task.status === 'running') {
    task.status = 'cancelled';
  }
}

/**
 * 在两个存储之间迁移文件
 * @param source 源存储
 * @param target 目标存储
 * @param files 文件列表 [{ hash, name }]
 * @param mode 迁移模式: copy=复制, new=新文件用新(不迁移), switch=直接切换
 * @param taskId 任务ID用于查询进度
 */
export async function migrateFiles(
  source: IStorage,
  target: IStorage,
  files: Array<{ hash: string; name: string }>,
  mode: MigrationMode,
  taskId: string
): Promise<MigrationProgress> {
  const progress: MigrationProgress = {
    total: files.length,
    processed: 0,
    success: 0,
    failed: 0,
    currentFile: '',
    status: 'running',
    errors: [],
    startTime: Date.now(),
  };
  migrationTasks.set(taskId, progress);

  // switch 模式：不需要迁移文件，只切换配置
  if (mode === 'switch') {
    progress.status = 'completed';
    progress.endTime = Date.now();
    return progress;
  }

  for (const file of files) {
    if (progress.status === 'cancelled') break;

    progress.currentFile = file.name;
    try {
      // 检查目标存储是否已有此文件
      const exists = await target.exists(file.hash);
      if (exists) {
        progress.success++;
        progress.processed++;
        continue;
      }

      // 从源存储下载
      const data = await source.get(file.hash);
      if (!data) {
        progress.failed++;
        progress.errors.push(`${file.name}: 源存储读取失败`);
        progress.processed++;
        continue;
      }

      // 上传到目标存储
      const buf = await data.arrayBuffer();
      const ok = await target.upload(file.hash, buf, (data as any).httpMetadata?.contentType);
      if (ok) {
        progress.success++;
      } else {
        progress.failed++;
        progress.errors.push(`${file.name}: 目标存储写入失败`);
      }
    } catch (e: any) {
      progress.failed++;
      progress.errors.push(`${file.name}: ${e.message || e}`);
    }
    progress.processed++;
  }

  if (progress.status !== 'cancelled') {
    progress.status = progress.failed === 0 ? 'completed' : 'failed';
  }
  progress.endTime = Date.now();
  return progress;
}
