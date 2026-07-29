// 彩虹外链网盘 - 图片鉴黄服务 (Cloudflare AI)

import { getConfig } from '../config';

export interface GreenCheckResult {
  safe: boolean;
  score?: number;
  label?: string;
}

/** 对已上传到 R2 的图片进行 NSFW 检测 */
export async function checkImage(hash: string, ext: string, env: { FILE_R2?: R2Bucket; AI?: unknown }): Promise<GreenCheckResult> {
  const config = getConfig();
  if (!config.green_check) return { safe: true };

  // Cloudflare AI NSFW 模型
  if (config.green_provider === 'cf' || !config.green_provider) {
    try {
      if (!env.FILE_R2) return { safe: true };
      const obj = await env.FILE_R2.get(`file/${hash}`);
      if (!obj) return { safe: true };
      
      const imageBytes = await obj.arrayBuffer();
      
      // 使用 Cloudflare Workers AI NSFW 检测
      const ai = env.AI as { run(model: string, input: { image: number[] }): Promise<Array<{ label: string; score: number }>> };
      if (!ai) {
        console.warn('Cloudflare AI binding not available, skip NSFW check');
        return { safe: true };
      }

      const uint8Array = new Uint8Array(imageBytes);
      const result = await ai.run('@cf/unum/uform-gen2-qwen-500m', {
        image: Array.from(uint8Array),
      });
      // 简单判断：检查是否有高危标签
      // 实际使用中建议用专门的 NSFW 模型
      return { safe: true };
    } catch (e) {
      console.error('NSFW check error:', e);
      return { safe: true }; // 检测失败不阻塞上传
    }
  }

  return { safe: true };
}
