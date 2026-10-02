import type { AssistantPageContext, AssistantScope } from '../src/contracts/assistant';
/** 仅生成现行合法快照；拒绝旧字段的用例直接构造请求。 */
export function pageSnapshot({ pageKey = 'assistant', ...scope }: AssistantScope = {}): AssistantPageContext {
  return { schemaVersion: 2, snapshotId: 'test-snapshot', routeInstanceId: 'test-route', contextVersion: 1, pageKey, scope };
}
