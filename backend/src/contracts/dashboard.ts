/** 工作台业务概况契约(T-6,AC-F03)。 */

export type DomainBlockKey = 'contract' | 'expense' | 'project_budget' | 'risk' | 'investment' | 'report';

export interface DomainMetricDto {
  label: string;
  /** 金额为元的十进制字符串,比率为 6 位小数字符串,计数为整数;不可用时为 null 并附 note */
  value: string | number | null;
  unit?: 'money' | 'ratio' | 'count';
  note?: string;
}

export interface DomainBlockDto { key: DomainBlockKey; label: string; path: string; metrics: DomainMetricDto[] }

export interface DashboardDomainsDto { blocks: DomainBlockDto[] }
