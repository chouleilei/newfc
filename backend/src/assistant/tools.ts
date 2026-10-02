import { zodToJsonSchema } from 'zod-to-json-schema';
import { AppError } from '../core/errors';
import type { DB } from '../db/connection';
import { BUDGET_TOOL_DEFINITIONS } from './budget-tools';
import { DOMAIN_TOOL_DEFINITIONS } from './domain-tools';
import { authorizeToolCall } from './tool-policy';
import type { ToolDefinition, ToolPolicy } from './tool-definition';

export const TOOL_REGISTRY = { ...BUDGET_TOOL_DEFINITIONS, ...DOMAIN_TOOL_DEFINITIONS } satisfies Record<string, ToolDefinition>;
export type ToolName = keyof typeof TOOL_REGISTRY;
export function toolDefinition(name: string): ToolDefinition | null {
  return Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, name) ? TOOL_REGISTRY[name as ToolName] : null;
}
export function toolPolicy(name: string, params: Record<string, unknown> = {}): ToolPolicy | null {
  const definition = toolDefinition(name);
  if (!definition) return null;
  if (typeof definition.policy !== 'function') return definition.policy;
  if (params.kind == null) return null;
  return definition.policy(params);
}
export const toolDefinitions = Object.entries(TOOL_REGISTRY).map(([name, definition]) => {
  const { $schema: _meta, ...parameters } = (zodToJsonSchema as (schema: unknown, options: { target: 'openApi3'; $refStrategy: 'none' }) => Record<string, unknown>)(definition.schema, { target: 'openApi3', $refStrategy: 'none' });
  return { type: 'function', function: { name, description: `${definition.label}：只读同源业务事实；金额和单位遵循该领域契约`, parameters } };
});
export function toolAcceptsParam(name: string, param: string): boolean {
  const definition = toolDefinition(name);
  return !!definition && Object.prototype.hasOwnProperty.call(definition.schema.shape, param);
}
export function toolLabel(name: string): string { return toolDefinition(name)?.label ?? name; }
/** Both model and deterministic routing validate and authorize through this executor. */
export function executeTool(db: DB, name: string, input: unknown = {}): any {
  const definition = toolDefinition(name);
  if (!definition) throw new AppError('TOOL_UNKNOWN', `未知工具: ${name}`, 400);
  const parsed = definition.schema.safeParse(input);
  if (!parsed.success) throw new AppError('TOOL_ARGUMENTS_INVALID', `工具参数无效: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 400);
  const args = authorizeToolCall(db, name, parsed.data);
  return definition.execute(db, args);
}
