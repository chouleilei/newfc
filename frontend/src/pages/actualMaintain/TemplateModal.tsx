import { useEffect, useState } from 'react';
import { Space, Button, Modal, Checkbox, TreeSelect, DatePicker, Form } from 'antd';
import type { Dayjs } from 'dayjs';
import { App } from 'antd';
import { download } from '../../api/client';
import type { SheetDef } from '../../utils/sheets';

interface OrgTreeItem { value: number; title: string; children: OrgTreeItem[] }

/**
 * 下载实际数填报模板配置弹窗:多年度/多组织/多表格自由组合,各自生成填报 Sheet。
 * 打开时按页面当前维度初始化勾选。
 */
export function TemplateModal(props: {
  open: boolean;
  onClose: () => void;
  years: number[];
  editYear: number;
  currentSheetKey: string;
  currentCutoff: Dayjs | null;
  orgTreeData: OrgTreeItem[];
  /** 打开时默认勾选的组织(当前组织或当前范围叶子) */
  initialOrgIds: number[];
  /** "全选所有末级组织"按钮对应的组织根下全部叶子 */
  allLeafOrgIds: number[];
  currentOrg?: { id: number; name: string } | null;
  dbSheets: SheetDef[];
}) {
  const { message } = App.useApp();
  const [tplYears, setTplYears] = useState<number[]>([new Date().getFullYear()]);
  const [tplOrgIds, setTplOrgIds] = useState<number[]>([]);
  const [tplSheetKeys, setTplSheetKeys] = useState<string[]>(['profit']);
  const [tplCutoff, setTplCutoff] = useState<Dayjs | null>(null);

  useEffect(() => {
    if (props.open) {
      setTplYears([props.editYear]);
      setTplOrgIds(props.currentOrg ? [props.currentOrg.id] : props.initialOrgIds);
      setTplSheetKeys([props.currentSheetKey]);
      // 默认沿用页面当前累计截止日;页面未选时不预设今天,由用户明确选择(UX-08)
      setTplCutoff(props.currentCutoff ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  const handleDoDownloadTemplate = () => {
    if (!tplYears.length) { message.error('请至少勾选一个填报年度'); return; }
    if (!tplSheetKeys.length) { message.error('请至少勾选一张填报表格'); return; }
    if (!tplCutoff) { message.error('请选择模板的截止日期'); return; }
    const cutoffStr = tplCutoff.format('YYYY-MM-DD');
    const query = new URLSearchParams();
    query.set('years', tplYears.join(','));
    if (tplOrgIds.length) query.set('orgIds', tplOrgIds.join(','));
    query.set('sheetKeys', tplSheetKeys.join(','));
    query.set('cutoff', cutoffStr);

    const yearPart = tplYears.length === 1 ? `${tplYears[0]}年` : `${tplYears[0]}-${tplYears[tplYears.length - 1]}年(${tplYears.length}个年度)`;
    const fname = `实际数填报模板-${yearPart}.xlsx`;
    // 成功/失败统一由 download() 广播、App 内 DownloadFeedback 提示,
    // 避免失败时仍先弹一句"下载中"造成误导
    void download(`/io/template/actual?${query.toString()}`, fname);
    props.onClose();
  };

  return (
    <Modal
      title="下载实际数填报模板（支持多组织、多年度、多表格）"
      open={props.open}
      onCancel={props.onClose}
      onOk={handleDoDownloadTemplate}
      okText="生成并下载模板"
      cancelText="取消"
      width={680}
    >
      <div style={{ marginTop: 12 }}>
        <Form layout="vertical">
          <Form.Item label={<strong>填报年度（多选）</strong>} extra="选中的各个年度将在模板中对应生成填报 Sheet">
            <Space direction="vertical" style={{ width: '100%' }}>
              <Checkbox.Group
                value={tplYears}
                onChange={(vals) => setTplYears(vals as number[])}
                options={props.years.map((y) => ({ label: `${y} 年`, value: y }))}
              />
              <Space size="small">
                <Button size="small" type="link" onClick={() => setTplYears([...props.years])}>全选所有年份</Button>
                <Button size="small" type="link" onClick={() => setTplYears([props.editYear])}>仅当前维护年 ({props.editYear})</Button>
                <Button size="small" type="link" onClick={() => setTplYears([new Date().getFullYear()])}>仅当前年份 ({new Date().getFullYear()})</Button>
              </Space>
            </Space>
          </Form.Item>

          <Form.Item label={<strong>预算组织（多选）</strong>} extra="选中的末级组织将在 Excel 中生成独立工作表（Tab）">
            <TreeSelect
              style={{ width: '100%' }}
              treeData={props.orgTreeData}
              value={tplOrgIds}
              treeCheckable={true}
              showCheckedStrategy={TreeSelect.SHOW_CHILD}
              allowClear
              treeDefaultExpandAll
              placeholder="请选择填报组织（默认全部末级组织）"
              onChange={(v) => setTplOrgIds((v as number[]) ?? [])}
            />
            <Space size="small" style={{ marginTop: 4 }}>
              <Button size="small" type="link" onClick={() => setTplOrgIds(props.allLeafOrgIds)}>全选所有末级组织</Button>
              {props.currentOrg && <Button size="small" type="link" onClick={() => setTplOrgIds([props.currentOrg!.id])}>仅当前组织 ({props.currentOrg.name})</Button>}
            </Space>
          </Form.Item>

          <Form.Item label={<strong>表格范围（多选）</strong>} extra="每个表格内置对应的层级排版、固定汇总公式与单元格保护锁定">
            <Checkbox.Group
              value={tplSheetKeys}
              onChange={(vals) => setTplSheetKeys(vals as string[])}
              options={[
                { label: '利润表', value: 'profit' },
                { label: '一级汇总', value: 'overview' },
                ...props.dbSheets.map((s) => ({ label: s.name, value: s.key })),
                { label: '全部科目明细', value: 'all' },
              ]}
            />
            <Space size="small" style={{ marginTop: 4 }}>
              <Button size="small" type="link" onClick={() => setTplSheetKeys(['profit', 'overview', ...props.dbSheets.map((s) => s.key), 'all'])}>全选所有表格</Button>
              <Button size="small" type="link" onClick={() => setTplSheetKeys(['profit'])}>仅利润表</Button>
              <Button size="small" type="link" onClick={() => setTplSheetKeys(props.dbSheets.some((s) => s.key === 'master') ? ['master'] : props.dbSheets[0] ? [props.dbSheets[0].key] : ['all'])}>仅收入成本表</Button>
              <Button size="small" type="link" onClick={() => setTplSheetKeys(['all'])}>仅全部科目明细</Button>
            </Space>
          </Form.Item>

          <Form.Item label={<strong>截止日期</strong>}>
            <DatePicker
              value={tplCutoff}
              onChange={setTplCutoff}
              allowClear={false}
              placeholder="选择截止日期"
              style={{ width: 200 }}
            />
          </Form.Item>
        </Form>
      </div>
    </Modal>
  );
}
