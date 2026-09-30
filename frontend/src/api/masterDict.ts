/** T-7 主数据字典项接口(AC-F07)。 */
import { api } from './client';
import { qs } from './financeData';
import type { DictItemCreate, DictItemDto, DictItemUpdate, DictTypeDto } from '@contracts/master-dict';

export type * from '@contracts/master-dict';

export const dictApi = {
  types: () => api.get<{ items: DictTypeDto[] }>('/master/dict-types'),
  items: (q: { dictType?: string; status?: 'active' | 'inactive' } = {}) => api.get<{ items: DictItemDto[] }>(`/master/dict-items${qs(q)}`),
  create: (body: DictItemCreate) => api.post<DictItemDto>('/master/dict-items', body),
  update: (id: number, body: DictItemUpdate) => api.patch<DictItemDto>(`/master/dict-items/${id}`, body),
};
