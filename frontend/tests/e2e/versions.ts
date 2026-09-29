import { expect, type APIRequestContext } from '@playwright/test';

interface VersionRow { id: number; year: number; kind: 'budget' | 'forecast'; is_current: number; name: string }

/** 夹具里的版本 id 取决于生成顺序，用例一律现查当前生效版本，不写死数字。 */
export async function currentBudgetVersionId(
  request: APIRequestContext,
  token: string,
  year: number,
  kind: 'budget' | 'forecast' = 'budget',
): Promise<number> {
  const response = await request.get(`/api/versions?year=${year}`, { headers: { 'x-access-token': token } });
  expect(response.ok(), `读取 ${year} 年版本列表失败: ${response.status()}`).toBeTruthy();
  const versions = (await response.json()) as VersionRow[];
  const hit = versions.find((version) => version.kind === kind && version.is_current === 1);
  expect(hit, `${year} 年缺少当前生效的${kind === 'budget' ? '预算' : '预测'}版本`).toBeTruthy();
  return hit!.id;
}
