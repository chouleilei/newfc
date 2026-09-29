/**
 * UX-07 共享「定稿 / 设为当前采用」确认框:版本列表与预算编辑页两个入口共用,
 * 保证两处展示一致的质量摘要、后果说明与替换对象。
 * - 定稿确认:年度/版本名/用途 + 完整质量检查摘要(阻塞/提醒,可定位) + 后果
 *   (定稿后不可原地修改,修订走「复制为新草稿」;定稿不自动成为当前采用版本);
 * - 采用确认:原采用版本 → 新采用版本(原采用可为「无」),
 *   每个年度的预算与预测各自维持一个当前采用版本;
 * - 提交失败(含 409 过期确认)的后端原因内联展示在弹窗内并保留弹窗,
 *   数据刷新由调用方负责。
 */
import { Alert, Modal, Tag, Typography } from 'antd';
import { QualityReportContent, type QualityReportData } from './QualityReport';

export interface ConfirmVersionInfo {
  id: number;
  year: number;
  name: string;
  kind: 'budget' | 'forecast';
}

export function kindLabel(kind: 'budget' | 'forecast'): string {
  return kind === 'forecast' ? '预测' : '预算';
}

export function FinalizeConfirmModal(props: {
  open: boolean;
  version: ConfirmVersionInfo;
  quality: QualityReportData;
  confirmPending: boolean;
  /** 提交失败原因(409 冲突/质量门禁等),内联展示且不清空弹窗 */
  error: string | null;
  onLocate?: (orgId: number, accountId: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { version, quality } = props;
  return (
    <Modal
      open={props.open}
      title={`定稿确认:${version.year} 年 · ${version.name}`}
      okText="确认定稿"
      cancelText="再检查一下"
      confirmLoading={props.confirmPending}
      okButtonProps={{ disabled: !quality.canFinalize }}
      onOk={props.onConfirm}
      onCancel={props.onCancel}
      width={720}
      maskClosable={false}
    >
      <div style={{ marginBottom: 8 }}>
        <Tag color={version.kind === 'forecast' ? 'purple' : 'blue'}>{version.kind === 'forecast' ? '全年预测' : '年度预算'}</Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          定稿前请确认以下质量检查结果;存在阻塞项时不能定稿,提醒项可逐条定位复核。
        </Typography.Text>
      </div>
      {props.error && (
        <Alert type="error" showIcon style={{ marginBottom: 12 }} message="定稿未完成" description={props.error} />
      )}
      <QualityReportContent quality={quality} onLocate={props.onLocate} />
      <Alert
        type="warning"
        showIcon
        style={{ marginTop: 12 }}
        message="定稿的后果"
        description="定稿后这一版不可再原地修改;后续修订请用「基于此版继续编制」复制为新草稿。定稿只冻结内容,不会自动把这一版设为当前采用版本。"
      />
    </Modal>
  );
}

export function SetCurrentConfirmModal(props: {
  open: boolean;
  version: ConfirmVersionInfo;
  /** 确认时记录的原采用版本;null 表示该年度该用途当前没有采用版本 */
  previousCurrent: { id: number; name: string } | null;
  confirmPending: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { version, previousCurrent } = props;
  const label = kindLabel(version.kind);
  return (
    <Modal
      open={props.open}
      title={`设为当前${label}:${version.year} 年 · ${version.name}`}
      okText={`设为当前${label}`}
      cancelText="取消"
      confirmLoading={props.confirmPending}
      onOk={props.onConfirm}
      onCancel={props.onCancel}
      maskClosable={false}
    >
      {props.error && (
        <Alert type="error" showIcon style={{ marginBottom: 12 }} message="设置未完成" description={props.error} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0 12px', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--bd-text-secondary)' }}>原采用版本</span>
        <Typography.Text strong={Boolean(previousCurrent)} type={previousCurrent ? undefined : 'secondary'}>
          {previousCurrent ? previousCurrent.name : '(当前没有采用版本)'}
        </Typography.Text>
        <i className="ri-arrow-right-line" aria-hidden />
        <span style={{ color: 'var(--bd-text-secondary)' }}>新采用版本</span>
        <Typography.Text strong>{version.name}</Typography.Text>
      </div>
      <Alert
        type="info"
        showIcon
        message="每个年度的预算与预测各自维持一个当前采用版本"
        description={previousCurrent
          ? `设置后,执行分析与报表默认读取「${version.name}」;「${previousCurrent.name}」不再是当前${label},内容保留不受影响。`
          : `设置后,执行分析与报表默认读取「${version.name}」;该年度此前没有当前${label}。`}
      />
    </Modal>
  );
}
