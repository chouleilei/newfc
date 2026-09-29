import { Alert, Button, Card, Modal, Space, Tag, Tooltip, Typography } from 'antd';

/**
 * 统一可见导入入口(UX-13,方案 §4.4):预算/实际页头「导入 Excel」打开本组件,
 * 按用户手里的文件来源选择导入路径,每条路径简述需要确认的内容。
 * 可选路径由编辑目标决定,不支持的组合不出现:
 * - 预算草稿:标准模板导入 + 非标准 Excel 清洗(财务转换只写实际数,不出现);
 * - 更新当前实际:再加财务系统转换;
 * - 补录历史快照:仅现有支持的标准模板导入(清洗/财务转换暂不支持历史任务,给出说明)。
 */

export type ImportEntryKind = 'standard' | 'cleaning' | 'finance';
export type ImportEntryContext = 'budget' | 'actual-current' | 'actual-history';

export interface ImportPathInfo {
  kind: ImportEntryKind;
  title: string;
  /** 用户手里的文件来源 */
  fileSource: string;
  /** 该路径主要需要用户确认的内容 */
  confirmPoints: string[];
  actionLabel: string;
  icon: string;
}

export const IMPORT_PATHS: Record<ImportEntryKind, ImportPathInfo> = {
  standard: {
    kind: 'standard',
    title: '标准模板导入',
    fileSource: '从本系统下载的导入模板',
    confirmPoints: ['写入目标与期间', '文件内容变化(新增/覆盖/清零等)'],
    actionLabel: '选择模板文件',
    icon: 'ri-file-excel-2-line',
  },
  cleaning: {
    kind: 'cleaning',
    title: '非标准 Excel 清洗',
    fileSource: '自己整理的 Excel(表头、列序不固定)',
    confirmPoints: ['工作表与行列对应', '金额单位(元/万元需明确选择,系统不按数值大小猜测)', '名称匹配与差异预览'],
    actionLabel: '打开清洗向导',
    icon: 'ri-magic-line',
  },
  finance: {
    kind: 'finance',
    title: '财务系统转换',
    fileSource: '财务系统导出的科目余额表、利润表',
    confirmPoints: ['数据源与期间', '映射版本及核对结果'],
    actionLabel: '前往财务转换页',
    icon: 'ri-exchange-funds-line',
  },
};

/** 按编辑目标返回可选导入路径;不支持的组合不出现(UX-13 验收)。 */
export function importEntryKinds(context: ImportEntryContext): ImportEntryKind[] {
  switch (context) {
    case 'budget': return ['standard', 'cleaning'];
    case 'actual-history': return ['standard'];
    case 'actual-current': return ['standard', 'cleaning', 'finance'];
  }
}

/** 有路径被裁减时给出原因说明;全部可用时返回 null。 */
export function importEntryHint(context: ImportEntryContext): string | null {
  switch (context) {
    case 'budget':
      return '财务系统转换只写入实际数，不在预算版本提供；请到「实际数录入」页使用。';
    case 'actual-history':
      return '补录历史快照当前仅支持标准模板导入：非标准 Excel 清洗与财务系统转换暂不支持历史任务。';
    case 'actual-current':
      return null;
  }
}

export interface ImportEntryOptionsProps {
  context: ImportEntryContext;
  /** 按路径给出禁用原因(如年度冻结);未给出的路径可正常选择 */
  disabledReasons?: Partial<Record<ImportEntryKind, string>>;
  onPick: (kind: ImportEntryKind) => void;
  /** 标准路径附带「下载导入模板」入口 */
  onDownloadTemplate?: () => void;
}

/** 路径卡片列表(独立于 Modal 导出,便于静态渲染测试)。 */
export function ImportEntryOptions(props: ImportEntryOptionsProps) {
  const hint = importEntryHint(props.context);
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {importEntryKinds(props.context).map((kind) => {
        const info = IMPORT_PATHS[kind];
        const reason = props.disabledReasons?.[kind];
        const action = (
          <Button type="primary" ghost icon={<i className={info.icon} aria-hidden />} disabled={reason != null} onClick={() => props.onPick(kind)}>
            {info.actionLabel}
          </Button>
        );
        return (
          <Card size="small" key={kind}>
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <Space size={8} wrap>
                <Typography.Text strong>{info.title}</Typography.Text>
                <Tag>{info.fileSource}</Tag>
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                需要确认：{info.confirmPoints.join('；')}。
              </Typography.Text>
              <Space wrap>
                {reason ? <Tooltip title={reason}><span>{action}</span></Tooltip> : action}
                {kind === 'standard' && props.onDownloadTemplate && (
                  <Button icon={<i className="ri-download-2-line" aria-hidden />} onClick={props.onDownloadTemplate}>下载导入模板</Button>
                )}
              </Space>
            </Space>
          </Card>
        );
      })}
      {hint && <Alert type="info" showIcon message={hint} />}
    </Space>
  );
}

export interface ImportEntryModalProps extends ImportEntryOptionsProps {
  open: boolean;
  /** 导入目标摘要(版本/年度与任务),帮助用户确认导入对象 */
  targetLabel: string;
  onClose: () => void;
}

export default function ImportEntryModal(props: ImportEntryModalProps) {
  return (
    <Modal open={props.open} title="导入 Excel" footer={null} onCancel={props.onClose} width={640} destroyOnClose>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        导入目标：{props.targetLabel}。请按文件来源选择导入方式：
      </Typography.Paragraph>
      <ImportEntryOptions
        context={props.context}
        disabledReasons={props.disabledReasons}
        onPick={props.onPick}
        onDownloadTemplate={props.onDownloadTemplate}
      />
    </Modal>
  );
}
