import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/** 统一处理偶发的业务 chunk 加载失败：短暂退避后重试一次。 */
export function lazyWithRetry<T extends ComponentType<unknown>>(
  importer: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(async () => {
    try { return await importer(); }
    catch { await new Promise((resolve) => window.setTimeout(resolve, 500)); return importer(); }
  });
}
