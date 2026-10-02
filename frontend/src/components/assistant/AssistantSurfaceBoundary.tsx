/**
 * AssistantSurfaceBoundary(现行 specs/ai.md 页面上下文契约§8.4)。
 *
 * Drawer、Modal、Popover 的共同生命周期由这一个轻量边界处理：
 * - open 时登记浮层(按打开顺序即优先顺序)，关闭或卸载时立即注销；
 * - 向子树提供自身 id，子级浮层(如 Drawer 内的核验 Popover)自动挂为子浮层；
 * - 父浮层注销时注册中心级联清理子浮层(§5.4)。
 */
import { type ReactNode } from 'react';
import { AssistantSurfaceParentContext } from '../../assistant/AssistantContextRegistry';
import { useAssistantSurface } from '../../assistant/contextHooks';
import type { SurfaceKind } from '../../assistant/context';

export function AssistantSurfaceBoundary({ open, kind, surfaceKey, entity, parentId, children }: {
  open: boolean;
  kind: SurfaceKind;
  /** 稳定语义键，如 evidence_detail、verification_detail、note_editor */
  surfaceKey: string;
  entity?: { entityType: string; id: number } | null;
  parentId?: string | null;
  children: ReactNode;
}) {
  const id = useAssistantSurface({ open, kind, key: surfaceKey, entity: entity ?? null, parentId });
  return (
    <AssistantSurfaceParentContext.Provider value={id}>
      {children}
    </AssistantSurfaceParentContext.Provider>
  );
}
