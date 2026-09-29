/**
 * 网格页共享构件:多级组织列体系构建 + 科目类型标签配色。
 * 预算编制页(BudgetEdit)与历史数据维护页(ActualMaintain)共用同一套列展开逻辑。
 */
import { withAlpha, type ThemeMode } from '../theme';

export interface OrgColDef {
  key: string;
  id: number;
  code: string;
  name: string;
  depth: number;
  isLeaf: boolean;
  isRootTotal?: boolean;
  isSubtotal?: boolean;
  leafIds: number[];
}

export interface OrgTreeIndex {
  byId: Map<number, { id: number; code: string; name: string }>;
  children: Map<number, number[]>;
  leavesUnder: (id: number) => number[];
}

/**
 * 多级组织列体系:最左侧根汇总列 + 板块小计列 + 末级子电站/单位明细列。
 * 小计列可折叠(折叠后不再平铺后代列);scopeLeaves 为当前范围内全部叶子组织。
 */
export function buildOrgDisplayCols(
  orgIndex: OrgTreeIndex,
  scopeId: number | null,
  scopeLeaves: number[],
  collapsedOrgCols: Set<number>,
): OrgColDef[] {
  if (scopeId == null) return [];
  const scopeNode = orgIndex.byId.get(scopeId);
  if (!scopeNode) return [];

  const leafSet = new Set(scopeLeaves);

  // 若选中的本身就是末级叶子，只展现该单列
  if (leafSet.has(scopeId) || scopeLeaves.length <= 1) {
    return [{
      key: `org-${scopeId}`,
      id: scopeId,
      code: scopeNode.code,
      name: scopeNode.name,
      depth: 0,
      isLeaf: true,
      leafIds: [scopeId],
    }];
  }

  const cols: OrgColDef[] = [];

  // 1. 最左侧首列: 选定范围的根汇总列(如 澧水集团(汇总))
  cols.push({
    key: `total-${scopeId}`,
    id: scopeId,
    code: scopeNode.code,
    name: `${scopeNode.name} (汇总)`,
    depth: 0,
    isLeaf: false,
    isRootTotal: true,
    leafIds: scopeLeaves,
  });

  // 2. 深度优先递归遍历子节点(包含板块小计与子组织)
  const traverse = (parentId: number, depth: number) => {
    const childIds = orgIndex.children.get(parentId) ?? [];
    for (const cid of childIds) {
      const cNode = orgIndex.byId.get(cid);
      if (!cNode) continue;
      const cLeaves = orgIndex.leavesUnder(cid).filter((id) => leafSet.has(id));
      if (cLeaves.length === 0) continue;

      if (leafSet.has(cid)) {
        // 叶子节点
        cols.push({
          key: `org-${cid}`,
          id: cid,
          code: cNode.code,
          name: cNode.name,
          depth,
          isLeaf: true,
          leafIds: [cid],
        });
      } else {
        // 非叶子子板块 (小计列，如 澧水本级(小计)、澧能公司(小计)、全州优能(小计))
        cols.push({
          key: `subtotal-${cid}`,
          id: cid,
          code: cNode.code,
          name: `${cNode.name} (小计)`,
          depth,
          isLeaf: false,
          isSubtotal: true,
          leafIds: cLeaves,
        });

        // 若未被折叠，递归平铺下属子节点
        if (!collapsedOrgCols.has(cid)) {
          traverse(cid, depth + 1);
        }
      }
    }
  };

  traverse(scopeId, 1);
  return cols;
}

export interface TypeChipStyle { color: string; bg: string; border: string; }

/**
 * 科目类型芯片配色(明暗双模式),与主题 FINANCE_COLOR 的类型语义对齐:
 * 收入蓝 / 成本橙 / 费用紫;红绿只保留给状态语义。数量行用青色、指标行用中性灰,
 * 避免与费用紫、收入蓝混淆。亮色文字取同色系加深变体保证对比度,暗色用 alpha 叠加。
 */
export function typeTagConfig(mode: ThemeMode): Record<string, TypeChipStyle> {
  if (mode === 'dark') {
    return {
      income: { color: '#93b0d6', bg: withAlpha('#93b0d6', 0.16), border: withAlpha('#93b0d6', 0.42) },
      cost: { color: '#e0a458', bg: withAlpha('#e0a458', 0.16), border: withAlpha('#e0a458', 0.42) },
      expense: { color: '#b39ddb', bg: withAlpha('#b39ddb', 0.16), border: withAlpha('#b39ddb', 0.42) },
      quantity: { color: '#7fb8a8', bg: withAlpha('#7fb8a8', 0.14), border: withAlpha('#7fb8a8', 0.4) },
      metric: { color: '#b3a990', bg: withAlpha('#b3a990', 0.14), border: withAlpha('#b3a990', 0.32) },
    };
  }
  return {
    income: { color: '#3a5a8c', bg: '#e4e9f2', border: '#bfcbe0' },
    cost: { color: '#b45309', bg: '#f6e8d2', border: '#e3c69a' },
    expense: { color: '#6b4fa8', bg: '#eae4f4', border: '#c8bade' },
    quantity: { color: '#4a7d6b', bg: '#ddeae5', border: '#aecabf' },
    metric: { color: '#6b6252', bg: '#efe9dc', border: '#d5cbb4' },
  };
}
