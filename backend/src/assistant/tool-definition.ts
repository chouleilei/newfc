import type { z } from 'zod';
import type { DB } from '../db/connection';
import type { DomainCapability } from '../contracts/page-catalog';
import type { Permission } from '../contracts/permissions';
import type { SelectionDescriptor } from '../contracts/assistant';
import type { SelectionExecution } from './selection-context';
export type ToolScope = 'global' | 'org_tree' | 'org_scope' | 'org_cell' | 'all_orgs';
export interface ToolPolicy { permission: Permission; scope: ToolScope }
export interface ToolDefinition {
  label: string;
  schema: z.AnyZodObject;
  capabilities: DomainCapability[];
  universal: boolean;
  policy: ToolPolicy | ((params: Record<string, unknown>) => ToolPolicy);
  selectionModes?: SelectionDescriptor['mode'][];
  execute: (db: DB, params: any, selection?: SelectionExecution) => unknown;
}

/** Erase schema internals after checking each definition; retain the literal tool names. */
export function defineTools<T extends Record<string, ToolDefinition>>(definitions: T): { [K in keyof T]: ToolDefinition } {
  return definitions;
}
