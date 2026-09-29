// @vitest-environment jsdom
/**
 * UX-07 共享定稿/采用确认组件单元测试:
 * - 定稿确认展示年度/版本名/完整质量摘要(阻塞/提醒)与后果说明;存在阻塞时禁用确认
 * - 采用确认展示「原采用 → 新采用」(原采用可为无),预算与预测文案各自切换
 * - 提交失败原因(如 409 过期确认)内联展示在弹窗内
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FinalizeConfirmModal, SetCurrentConfirmModal } from './VersionLifecycleConfirm';
import type { QualityReportData } from './QualityReport';

afterEach(() => cleanup());

const version = { id: 7, year: 2026, name: '年初预算', kind: 'budget' as const };

const qualityOk: QualityReportData = {
  canFinalize: true,
  blockingCount: 0,
  warningCount: 1,
  coverage: { filled: 8, total: 10, percent: 80 },
  issues: [{ code: 'CALCULATION_OUTPUT_MISSING', severity: 'warning', message: '测算模板输入完整但未试算' }],
};

const qualityBlocked: QualityReportData = {
  canFinalize: false,
  blockingCount: 1,
  warningCount: 0,
  coverage: { filled: 8, total: 10, percent: 80 },
  issues: [{ code: 'REQUIRED_VALUE_MISSING', severity: 'blocking', message: '必填科目未填报' }],
};

describe('FinalizeConfirmModal(UX-07)', () => {
  it('展示版本信息、质量摘要与后果说明;可定稿时确认按钮可用', () => {
    render(<FinalizeConfirmModal open version={version} quality={qualityOk} confirmPending={false} error={null} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/定稿确认:2026 年 · 年初预算/)).toBeTruthy();
    expect(screen.getByText('提醒 1')).toBeTruthy();
    expect(screen.getByText('测算模板输入完整但未试算')).toBeTruthy();
    expect(screen.getByText(/定稿后这一版不可再原地修改/)).toBeTruthy();
    expect(screen.getByText(/不会自动把这一版设为当前采用版本/)).toBeTruthy();
    expect((screen.getByText('确认定稿') as HTMLElement).closest('button')?.disabled).toBe(false);
  });

  it('存在阻塞项时禁用确认;409 等原因内联展示', () => {
    render(
      <FinalizeConfirmModal
        open
        version={version}
        quality={qualityBlocked}
        confirmPending={false}
        error="版本在你确认期间已被修改（当前修订 9，确认基线 8），请刷新后查看最新内容再定稿"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('阻塞 1')).toBeTruthy();
    expect(screen.getByText('必填科目未填报')).toBeTruthy();
    expect((screen.getByText('确认定稿') as HTMLElement).closest('button')?.disabled).toBe(true);
    expect(screen.getByText(/当前修订 9/)).toBeTruthy();
  });
});

describe('SetCurrentConfirmModal(UX-07)', () => {
  it('展示原采用 → 新采用;原采用版本被替换但内容保留', () => {
    render(<SetCurrentConfirmModal open version={version} previousCurrent={{ id: 3, name: '上年结转版' }} confirmPending={false} error={null} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('原采用版本')).toBeTruthy();
    expect(screen.getByText('上年结转版')).toBeTruthy();
    expect(screen.getByText('新采用版本')).toBeTruthy();
    expect(screen.getByText(/不再是当前预算/)).toBeTruthy();
  });

  it('原采用为无时明确标示;预测用途文案切换', () => {
    render(<SetCurrentConfirmModal open version={{ ...version, kind: 'forecast' }} previousCurrent={null} confirmPending={false} error={null} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('(当前没有采用版本)')).toBeTruthy();
    expect(screen.getByText('设为当前预测')).toBeTruthy();
    expect(screen.getByText(/该年度此前没有当前预测/)).toBeTruthy();
  });
});
