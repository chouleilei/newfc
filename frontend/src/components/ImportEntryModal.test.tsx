// @vitest-environment jsdom
/**
 * ImportEntryModal(UX-13)单元测试:
 * - 路径限制:预算=标准+清洗;更新当前实际=标准+清洗+财务转换;历史补录=仅标准
 * - 不支持的组合不渲染对应卡片动作,并给出可见原因说明
 * - 每条路径展示需要确认的内容;禁用原因使对应动作不可点
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigProvider } from 'antd';
import { ImportEntryOptions, importEntryHint, importEntryKinds } from './ImportEntryModal';

const render = (node: React.ReactElement) => renderToStaticMarkup(<ConfigProvider>{node}</ConfigProvider>);
const noop = () => {};

describe('importEntryKinds(按编辑目标限制导入路径)', () => {
  it('预算入口只提供标准模板导入与非标准清洗,不出现财务转换', () => {
    expect(importEntryKinds('budget')).toEqual(['standard', 'cleaning']);
  });
  it('财务系统转换只出现在「更新当前实际」入口', () => {
    expect(importEntryKinds('actual-current')).toEqual(['standard', 'cleaning', 'finance']);
  });
  it('历史补录任务只提供现有支持的标准模板导入', () => {
    expect(importEntryKinds('actual-history')).toEqual(['standard']);
  });
});

describe('importEntryHint(被裁减路径的说明)', () => {
  it('预算与历史补录给出原因说明,当前实际全部可用时无说明', () => {
    expect(importEntryHint('budget')).toContain('财务系统转换');
    expect(importEntryHint('actual-history')).toContain('暂不支持历史任务');
    expect(importEntryHint('actual-current')).toBeNull();
  });
});

describe('ImportEntryOptions 渲染', () => {
  it('预算上下文渲染标准与清洗两条路径,不渲染财务转换动作', () => {
    const html = render(<ImportEntryOptions context="budget" onPick={noop} />);
    expect(html).toContain('标准模板导入');
    expect(html).toContain('非标准 Excel 清洗');
    expect(html).toContain('选择模板文件');
    expect(html).toContain('打开清洗向导');
    expect(html).not.toContain('前往财务转换页');
    expect(html).toContain('财务系统转换只写入实际数');
  });

  it('当前实际上下文渲染全部三条路径且无裁减说明', () => {
    const html = render(<ImportEntryOptions context="actual-current" onPick={noop} />);
    expect(html).toContain('选择模板文件');
    expect(html).toContain('打开清洗向导');
    expect(html).toContain('前往财务转换页');
    expect(html).not.toContain('暂不支持历史任务');
  });

  it('历史补录上下文只渲染标准路径,并说明清洗/财务转换不支持', () => {
    const html = render(<ImportEntryOptions context="actual-history" onPick={noop} />);
    expect(html).toContain('选择模板文件');
    expect(html).not.toContain('打开清洗向导');
    expect(html).not.toContain('前往财务转换页');
    expect(html).toContain('非标准 Excel 清洗与财务系统转换暂不支持历史任务');
  });

  it('每条路径展示需要确认的内容;标准路径附带模板下载入口', () => {
    const html = render(<ImportEntryOptions context="actual-current" onPick={noop} onDownloadTemplate={noop} />);
    expect(html).toContain('需要确认');
    expect(html).toContain('写入目标与期间');
    expect(html).toContain('映射版本及核对结果');
    expect(html).toContain('下载导入模板');
  });

  it('禁用原因使对应路径动作不可点', () => {
    const enabledHtml = render(<ImportEntryOptions context="actual-current" onPick={noop} />);
    expect(enabledHtml.match(/<button[^>]*\sdisabled[=\s>]/g) ?? []).toHaveLength(0);
    const disabledHtml = render(
      <ImportEntryOptions context="actual-current" onPick={noop} disabledReasons={{ standard: '年度已冻结' }} />,
    );
    expect(disabledHtml.match(/<button[^>]*\sdisabled[=\s>]/g) ?? []).toHaveLength(1);
  });
});
