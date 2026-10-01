/** T-7 系统设置补齐接口(AC-F23):自定义字段、导入字段模板、AI 提示补充。 */
import { api } from './client';
import { qs } from './financeData';
import type {
  CustomFieldCreate, CustomFieldDomain, CustomFieldDto, CustomFieldUpdate, ImportAliasCreate, ImportAliasDataType, ImportAliasDto, ImportAliasUpdate,
  ImportTargetCatalogDto, PromptSupplementDto,
} from '@contracts/system-settings';

export type * from '@contracts/system-settings';

export const customFieldApi = {
  /** 表单用:当前有效定义(主数据读权限)。 */
  active: (domain: CustomFieldDomain) => api.get<{ items: CustomFieldDto[] }>(`/master/custom-fields${qs({ domain })}`),
  list: (domain?: CustomFieldDomain) => api.get<{ items: CustomFieldDto[] }>(`/settings/custom-fields${qs({ domain })}`),
  create: (body: CustomFieldCreate) => api.post<CustomFieldDto>('/settings/custom-fields', body),
  update: (id: number, body: CustomFieldUpdate) => api.patch<CustomFieldDto>(`/settings/custom-fields/${id}`, body),
};

export const importAliasApi = {
  targets: () => api.get<{ items: ImportTargetCatalogDto[] }>('/settings/import-field-targets'),
  list: (dataType?: ImportAliasDataType) => api.get<{ items: ImportAliasDto[] }>(`/settings/import-field-aliases${qs({ dataType })}`),
  create: (body: ImportAliasCreate) => api.post<ImportAliasDto>('/settings/import-field-aliases', body),
  update: (id: number, body: ImportAliasUpdate) => api.patch<ImportAliasDto>(`/settings/import-field-aliases/${id}`, body),
};

export const promptSupplementApi = {
  list: () => api.get<{ items: PromptSupplementDto[] }>('/settings/ai-prompt-supplements'),
  save: (taskKey: string, body: { content: string; expectedVersion: number }) => api.put<PromptSupplementDto>(`/settings/ai-prompt-supplements/${taskKey}`, body),
};
