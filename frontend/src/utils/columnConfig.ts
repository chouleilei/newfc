export interface MatrixColumnState {
  /** 所有已知列的稳定顺序；隐藏列也必须保留在这里。 */
  order: string[];
  /** 用户显式隐藏的列。 */
  hidden: string[];
  fixed: boolean;
}

export interface LegacyMatrixColumnState extends Partial<MatrixColumnState> {
  /** 旧版本只保存可见列；读取时迁移为 order + hidden。 */
  keys?: string[];
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is string => typeof value === 'string'))];
}

/**
 * 读取并迁移矩阵列配置。旧版 `keys` 中缺少的当前列代表用户曾经隐藏的列，
 * 不能在下一次 render 时把它们当成“新增列”自动恢复。
 */
export function restoreMatrixColumnState(
  saved: LegacyMatrixColumnState,
  available: string[],
  defaultFixed = true,
): MatrixColumnState {
  const current = uniqueStrings(available);
  if (Array.isArray(saved.order)) {
    return reconcileMatrixColumnState({
      order: uniqueStrings(saved.order),
      hidden: uniqueStrings(saved.hidden),
      fixed: typeof saved.fixed === 'boolean' ? saved.fixed : defaultFixed,
    }, current);
  }

  if (Array.isArray(saved.keys)) {
    // 即使查询数据尚未返回、available 暂时为空，也要保留旧可见键；组件会在
    // 首批列到达后完成一次迁移，届时才能判断哪些列是旧版显式隐藏项。
    const visible = uniqueStrings(saved.keys);
    const hidden = current.filter((key) => !visible.includes(key));
    return {
      order: [...visible, ...hidden],
      hidden,
      fixed: typeof saved.fixed === 'boolean' ? saved.fixed : defaultFixed,
    };
  }

  return { order: current, hidden: [], fixed: defaultFixed };
}

/**
 * 保留隐藏列和暂时不可用的列（例如组织小计折叠后的叶子列），仅把真正的新列追加。
 */
export function reconcileMatrixColumnState(state: MatrixColumnState, available: string[]): MatrixColumnState {
  const current = uniqueStrings(available);
  const order = uniqueStrings(state.order);
  const hidden = uniqueStrings(state.hidden);
  for (const key of current) {
    if (!order.includes(key)) order.push(key);
  }
  return { order, hidden, fixed: state.fixed };
}

export function visibleMatrixColumnKeys(state: MatrixColumnState, available: string[]): string[] {
  const availableSet = new Set(uniqueStrings(available));
  const hiddenSet = new Set(state.hidden);
  return state.order.filter((key) => availableSet.has(key) && !hiddenSet.has(key));
}

/** 将当前可用列的新顺序合并回完整顺序，同时保留暂时不可用列的位置。 */
export function mergeAvailableColumnOrder(state: MatrixColumnState, available: string[], nextAvailableOrder: string[]): string[] {
  const availableSet = new Set(uniqueStrings(available));
  const next = uniqueStrings(nextAvailableOrder).filter((key) => availableSet.has(key));
  let index = 0;
  const merged = state.order.map((key) => availableSet.has(key) ? (next[index++] ?? key) : key);
  for (; index < next.length; index += 1) merged.push(next[index]);
  return uniqueStrings(merged);
}

/** Ant Table 未显式 key 时，必须始终用它在原 columns 中的索引生成稳定键。 */
export function stableColumnKey<T extends object>(column: T, index: number): string {
  const candidate = column as { key?: unknown; dataIndex?: unknown };
  return String(candidate.key ?? candidate.dataIndex ?? `column-${index}`);
}

export function configuredItemsByKey<T extends { key: string }>(entries: T[], order: string[], hidden: string[]): T[] {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const hiddenSet = new Set(hidden);
  return order
    .map((key) => byKey.get(key))
    .filter((entry): entry is T => entry !== undefined)
    .filter((entry) => !hiddenSet.has(entry.key));
}
