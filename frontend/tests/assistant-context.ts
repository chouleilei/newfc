import type { AssistantPageContext, AssistantScope } from '../../backend/src/contracts/assistant';
export function pageSnapshot({ pageKey = 'assistant', ...scope }: AssistantScope = {}): AssistantPageContext {
  return { schemaVersion: 2, snapshotId: 'test-snapshot', routeInstanceId: 'test-route', contextVersion: 1, pageKey, scope };
}
