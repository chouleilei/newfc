/**
 * `.env` 加载器。
 *
 * README 与 `.env.example` 一直把 `.env` 当成官方配置入口，但后端进程原来根本不读它
 * (只有 start.sh 会 export)，导致文档里的 `npm start` / `npm run dev` 两种启动方式
 * 按文档配好模型也不生效。这里锁住三条口径：读得到、不覆盖已有变量、测试环境默认跳过。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadEnvFiles, envFileCandidates } from '../src/env';

function writeEnv(dir: string, name: string, content: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

describe('.env 加载', () => {
  it('解析注释、引号与 export 前缀，且不覆盖已存在的变量', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'));
    const file = writeEnv(dir, '.env', [
      '# 注释行',
      '',
      'AI_BASE_URL="https://api.example.com/v1"',
      "AI_MODEL='gpt-test'",
      'export AI_STREAM=1',
      'AI_TIMEOUT_MS = 30000',
      '不合法的行',
      'ALREADY_SET=fromFile',
      'EMPTY_KEPT=fromFile',
    ].join('\n'));
    const keys = ['AI_BASE_URL', 'AI_MODEL', 'AI_STREAM', 'AI_TIMEOUT_MS', 'ALREADY_SET', 'EMPTY_KEPT'];
    const saved = keys.map((key) => [key, process.env[key]] as const);
    for (const key of keys) delete process.env[key];
    process.env.ALREADY_SET = 'fromEnv';
    process.env.EMPTY_KEPT = ''; // 空字符串也算已显式设置(测试隔离依赖这一点)
    try {
      const result = loadEnvFiles([file], { allowInTest: true });
      expect(result.files).toEqual([file]);
      expect(process.env.AI_BASE_URL).toBe('https://api.example.com/v1');
      expect(process.env.AI_MODEL).toBe('gpt-test');
      expect(process.env.AI_STREAM).toBe('1');
      expect(process.env.AI_TIMEOUT_MS).toBe('30000');
      expect(process.env.ALREADY_SET).toBe('fromEnv');
      expect(process.env.EMPTY_KEPT).toBe('');
      expect(result.applied).not.toContain('ALREADY_SET');
      expect(result.applied).not.toContain('EMPTY_KEPT');
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('测试环境默认跳过，且缺失文件不报错', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'));
    const file = writeEnv(dir, '.env', 'SHOULD_NOT_LOAD=1');
    try {
      const skipped = loadEnvFiles([file]);
      expect(skipped.files).toEqual([]);
      expect(process.env.SHOULD_NOT_LOAD).toBeUndefined();
      expect(loadEnvFiles([path.join(dir, 'missing.env')], { allowInTest: true }).files).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('未加引号值的行内注释被剥离,引号内的 # 与紧贴值的 # 保留', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'));
    const file = writeEnv(dir, '.env', [
      'BUDGET_ACCESS_PASSWORD=secret # 密码后写注释不再把注释当成密码',
      'AI_MODEL=gpt-4 #多空格注释',
      'HASH_IN_VALUE=abc#def',
      'QUOTED_HASH="va # lue"',
    ].join('\n'));
    const keys = ['BUDGET_ACCESS_PASSWORD', 'AI_MODEL', 'HASH_IN_VALUE', 'QUOTED_HASH'];
    const saved = keys.map((key) => [key, process.env[key]] as const);
    for (const key of keys) delete process.env[key];
    try {
      loadEnvFiles([file], { allowInTest: true });
      expect(process.env.BUDGET_ACCESS_PASSWORD).toBe('secret');
      expect(process.env.AI_MODEL).toBe('gpt-4');
      expect(process.env.HASH_IN_VALUE).toBe('abc#def');
      expect(process.env.QUOTED_HASH).toBe('va # lue');
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('候选顺序为后端目录优先、仓库根目录其次', () => {
    const candidates = envFileCandidates('/tmp/project/backend');
    expect(candidates).toEqual(['/tmp/project/backend/.env', '/tmp/project/.env']);
  });
});
