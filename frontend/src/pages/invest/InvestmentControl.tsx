import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, App as AntdApp, Button, Col, DatePicker, Descriptions, Drawer, Empty, Form, Input, Modal, Row, Select, Space, Table, Tabs, Tag, Typography, Upload,
} from 'antd';
import dayjs from 'dayjs';
import { api, ApiError, can, download, errorText } from '../../api/client';
import {
  icApi, type IcComparisonDto, type IcComparisonRowDto, type IcImportDto, type IcItemDto, type IcProjectDetailDto, type IcProjectDto, type IcVersionSummaryDto,
  type IcVersionType,
} from '../../api/riskInvestment';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { useUrlId } from '../../hooks/useUrlId';
import { shortTime } from '../../utils/relativeTime';
import { compact, Money, OrgSelect, Ratio, statusTag, usePrompt } from '../financeData/shared';
import { IC_LEVEL, IC_MAPPING, IC_ROW_STATUS, IC_VERSION_STATUS, IC_VERSION_TYPE_LABEL, IC_VERSION_TYPES, RowErrors } from './shared';

/**
 * AC-F13 投资控制(四算对比):项目 → 版本导入(全量校验、预览、确认核对 sha256)→ 科目映射(自动 + 人工,未映射拦截确认)→ 确认冻结 →
 * 对比快照(偏差、偏差率、预警等级、控制链)与导出。红线取调整概算,否则设计概算;源版本作废不影响已有快照。
 */

interface MasterOption { id: number; code: string | null; name: string }
const ratioRule = { pattern: /^(0(\.\d{1,6})?|1(\.0{1,6})?)$/, message: '0～1 的小数,最多 6 位' };

function ComparisonModal({ id, onClose }: { id: number | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['ic-comparison', id], queryFn: () => icApi.comparison(id!), enabled: id != null });
  const c = q.data;
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const rows = (c?.rows ?? []).filter((r) => !onlyFlagged || r.alertLevel === 'warning' || r.alertLevel === 'exceed' || r.status !== 'compared');
  return (
    <Modal open={id != null} onCancel={onClose} footer={null} width={1180} destroyOnClose
      title={c ? `对比快照 #${c.id}:${c.base.typeLabel} V${c.base.versionNo} → ${c.target.typeLabel} V${c.target.versionNo}` : '对比快照'}>
      {q.error ? <QueryErrorResult title="快照加载失败" error={q.error} refetch={q.refetch} /> : !c ? null : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {c.summary.controlChain.map((x, i) => <Alert key={i} type="error" showIcon message={x.message} description={<>主体 <Money value={x.subjectAmount} /> 元 · 参照 <Money value={x.referenceAmount} /> 元</>} />)}
          <Descriptions size="small" column={4} bordered>
            <Descriptions.Item label="基准静态(元)"><Money value={c.summary.baseTotalStatic} /></Descriptions.Item>
            <Descriptions.Item label="目标静态(元)"><Money value={c.summary.targetTotalStatic} /></Descriptions.Item>
            <Descriptions.Item label="偏差(元)"><Money value={c.summary.totalDeviation} tone /></Descriptions.Item>
            <Descriptions.Item label="偏差率"><Space><Ratio value={c.summary.totalDeviationRate} />{statusTag(IC_LEVEL, c.summary.totalLevel)}</Space></Descriptions.Item>
            <Descriptions.Item label="基准动态(元)"><Money value={c.summary.baseTotalDynamic} /></Descriptions.Item>
            <Descriptions.Item label="目标动态(元)"><Money value={c.summary.targetTotalDynamic} /></Descriptions.Item>
            <Descriptions.Item label="红线(元)"><Money value={c.summary.redlineAmount} /></Descriptions.Item>
            <Descriptions.Item label="科目">超限 {c.summary.exceedCount} · 新增 {c.summary.newItemCount} · 取消 {c.summary.removedCount}</Descriptions.Item>
            <Descriptions.Item label="阈值" span={2}>正常 ≤ {c.thresholds.normal} · 关注 ≤ {c.thresholds.attention} · 预警 ≤ {c.thresholds.warning} · 超过为超限</Descriptions.Item>
            <Descriptions.Item label="生成" span={2}>{c.createdBy ?? '—'} · {shortTime(c.createdAt)} · sha256 {c.contentSha256.slice(0, 12)}…</Descriptions.Item>
          </Descriptions>
          <Space>
            <Button size="small" type={onlyFlagged ? 'primary' : 'default'} onClick={() => setOnlyFlagged(!onlyFlagged)}>只看预警/超限/新增/取消</Button>
            <Button size="small" onClick={() => void download(icApi.exportPath(c.id), `投资对比-${c.id}.xlsx`)}>导出 Excel</Button>
          </Space>
          <Table<IcComparisonRowDto> rowKey="canonicalCode" size="small" dataSource={rows} pagination={{ pageSize: 50 }} scroll={{ x: 1200, y: 460 }} columns={[
            { title: '科目编码', dataIndex: 'canonicalCode', width: 110, fixed: 'left' },
            { title: '科目名称', dataIndex: 'name', width: 200, render: (v: string, r) => <span style={{ paddingLeft: (r.level - 1) * 12 }}>{v}</span> },
            { title: '基准静态', dataIndex: 'baseStatic', width: 140, align: 'right', render: (v: string) => <Money value={v} /> },
            { title: '目标静态', dataIndex: 'targetStatic', width: 140, align: 'right', render: (v: string) => <Money value={v} /> },
            { title: '偏差', dataIndex: 'deviation', width: 140, align: 'right', render: (v: string) => <Money value={v} tone /> },
            { title: '偏差率', dataIndex: 'deviationRate', width: 100, align: 'right', render: (v: string | null) => <Ratio value={v} /> },
            { title: '等级', dataIndex: 'alertLevel', width: 80, render: (v: string | null) => statusTag(IC_LEVEL, v) },
            { title: '状态', dataIndex: 'status', width: 100, render: (v: string) => IC_ROW_STATUS[v] ?? v },
            { title: '动态偏差', dataIndex: 'dynamicDeviation', width: 140, align: 'right', render: (v: string) => <Money value={v} tone /> },
          ]} />
        </Space>
      )}
    </Modal>
  );
}

function VersionDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { message, modal } = AntdApp.useApp();
  const qc = useQueryClient();
  const [prompt, holder] = usePrompt();
  const [pending, setPending] = useState<Record<number, { action: 'map' | 'ignore' | 'reset'; canonicalCode?: string }>>({});
  const q = useQuery({ queryKey: ['ic-version', id], queryFn: () => icApi.version(id!), enabled: id != null });
  const v = q.data;
  useEffect(() => { setPending({}); }, [id]);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['ic-version', id] }); void qc.invalidateQueries({ queryKey: ['ic-project'] }); void qc.invalidateQueries({ queryKey: ['ic-projects'] }); };
  const draft = v?.status === 'draft' && can('investment:write');
  const saveMapping = useMutation({
    mutationFn: () => icApi.mapping(v!.id, v!.version, Object.entries(pending).map(([itemId, p]) => ({ itemId: Number(itemId), ...p }))),
    onSuccess: (d) => { message.success('映射已保存'); setPending({}); qc.setQueryData(['ic-version', id], d); refresh(); },
    onError: (e) => message.error(errorText(e)),
  });
  const confirm = useMutation({
    mutationFn: () => icApi.confirmVersion(v!.id, v!.version),
    onSuccess: () => { message.success('版本已确认并冻结,成为该类型当前版本'); refresh(); },
    onError: (e) => {
      const d = e instanceof ApiError ? (e.body.details as { items?: { code: string; name: string }[] } | undefined) : undefined;
      if (d?.items?.length) modal.error({ title: errorText(e), content: <ul style={{ maxHeight: 300, overflow: 'auto' }}>{d.items.map((i) => <li key={i.code}>{i.code} {i.name}</li>)}</ul> });
      else message.error(errorText(e));
    },
  });
  const voidIt = async () => {
    const r = await prompt({ title: '作废版本', description: '作废后不再参与对比与红线;已有对比快照不变。', fields: [{ name: 'reason', label: '原因', required: true, multiline: true }], danger: true, okText: '作废' });
    if (!r || !v) return;
    try { await icApi.voidVersion(v.id, v.version, r.reason); message.success('已作废'); refresh(); } catch (e) { message.error(errorText(e)); }
  };
  const canonicalOptions = (v?.canonicalItems ?? []).map((c) => ({ value: c.code, label: `${c.code} ${c.name}` }));
  const needCount = v?.mappingCounts.need_mapping ?? 0;
  return (
    <Drawer open={id != null} onClose={onClose} width={1100} destroyOnClose title={v ? `${v.typeLabel} V${v.versionNo} · ${v.name}` : '版本'}
      extra={v && (
        <Space>
          {draft && Object.keys(pending).length > 0 && <Button loading={saveMapping.isPending} onClick={() => saveMapping.mutate()}>保存映射({Object.keys(pending).length})</Button>}
          {draft && <Button type="primary" loading={confirm.isPending} onClick={() => confirm.mutate()}>确认冻结</Button>}
          {v.status === 'confirmed' && can('investment:write') && <Button danger onClick={() => void voidIt()}>作废</Button>}
        </Space>
      )}>
      {holder}
      {q.error ? <QueryErrorResult title="版本加载失败" error={q.error} refetch={q.refetch} /> : !v ? null : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {v.status === 'draft' && needCount > 0 && <Alert type="warning" showIcon message={`${needCount} 个科目待映射`} description="非零金额的待映射科目会阻止确认;可映射到规范科目或标记忽略。" />}
          {v.status === 'voided' && <Alert type="info" showIcon message={`已作废:${v.voidReason ?? ''}`} />}
          <Descriptions size="small" column={4} bordered>
            <Descriptions.Item label="状态">{statusTag(IC_VERSION_STATUS, v.status)}{v.isCurrent && <Tag color="blue">当前</Tag>}{v.isRedline && <Tag color="red">红线</Tag>}</Descriptions.Item>
            <Descriptions.Item label="静态合计(元)"><Money value={v.staticTotal} /></Descriptions.Item>
            <Descriptions.Item label="动态合计(元)"><Money value={v.dynamicTotal} /></Descriptions.Item>
            <Descriptions.Item label="批复">{v.approvalDocNo || '—'} {v.approvalDate ?? ''}</Descriptions.Item>
            <Descriptions.Item label="来源文件" span={2}>{v.sourceFileName ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="映射" span={2}>自动 {v.mappingCounts.matched} · 人工 {v.mappingCounts.manual} · 忽略 {v.mappingCounts.ignored} · 待映射 {needCount}</Descriptions.Item>
          </Descriptions>
          <Table<IcItemDto> rowKey="id" size="small" dataSource={v.items} pagination={{ pageSize: 100 }} scroll={{ x: 1100, y: 520 }} columns={[
            { title: '行', dataIndex: 'rowNo', width: 60 },
            { title: '编码', dataIndex: 'code', width: 100 },
            { title: '名称', dataIndex: 'name', width: 200, render: (x: string, r) => <span style={{ paddingLeft: (r.level - 1) * 12 }}>{x}</span> },
            { title: '分类', dataIndex: 'category', width: 90 },
            { title: '静态(元)', dataIndex: 'staticAmount', width: 130, align: 'right', render: (x: string) => <Money value={x} /> },
            { title: '动态(元)', dataIndex: 'dynamicAmount', width: 130, align: 'right', render: (x: string) => <Money value={x} /> },
            { title: '映射', dataIndex: 'mappingStatus', width: 100, render: (x: string, r) => (pending[r.id] ? <Tag color="gold">待保存</Tag> : statusTag(IC_MAPPING, x)) },
            {
              title: '规范科目', key: 'canonical', width: 300,
              render: (_: unknown, r) => (draft ? (
                <Space.Compact style={{ width: '100%' }}>
                  <Select size="small" showSearch allowClear optionFilterProp="label" style={{ width: 200 }} options={canonicalOptions}
                    value={pending[r.id]?.action === 'map' ? pending[r.id].canonicalCode : pending[r.id] ? undefined : r.canonicalCode ?? undefined}
                    onChange={(code?: string) => setPending((p) => ({ ...p, [r.id]: code ? { action: 'map', canonicalCode: code } : { action: 'reset' } }))} />
                  <Button size="small" onClick={() => setPending((p) => ({ ...p, [r.id]: { action: 'ignore' } }))}>忽略</Button>
                </Space.Compact>
              ) : r.canonicalCode ? `${r.canonicalCode} ${r.canonicalName ?? ''}` : '—'),
            },
          ]} />
        </Space>
      )}
    </Drawer>
  );
}

function ImportModal({ project, open, onClose, onDone }: { project: IcProjectDto; open: boolean; onClose: () => void; onDone: (versionId: number) => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ versionType: IcVersionType; name?: string; approvalDocNo?: string; approvalDate?: string }>();
  const [preview, setPreview] = useState<IcImportDto | null>(null);
  const upload = useMutation({
    mutationFn: async (f: File) => { const v = await form.validateFields(); return icApi.previewImport(project.id, f, compact(v) as { versionType: IcVersionType }); },
    onSuccess: setPreview, onError: (e) => message.error(errorText(e)),
  });
  const confirm = useMutation({
    mutationFn: () => icApi.confirmImport(preview!.id, preview!.sha256),
    onSuccess: (r) => { message.success('已导入为草稿版本,请检查映射后确认'); setPreview(null); onClose(); if (r.versionId) onDone(r.versionId); },
    onError: (e) => message.error(errorText(e)),
  });
  const close = () => { setPreview(null); onClose(); };
  return (
    <Modal open={open} title={`导入投资科目表 · ${project.code} ${project.name}`} width={820} onCancel={close} destroyOnClose
      okText="确认导入" okButtonProps={{ disabled: !preview || preview.errorCount > 0 }} confirmLoading={confirm.isPending} onOk={() => confirm.mutate()}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Form form={form} layout="vertical" initialValues={{ versionType: 'design_estimate' }}>
          <Row gutter={12}>
            <Col span={6}><Form.Item name="versionType" label="版本类型" rules={[{ required: true }]}><Select options={IC_VERSION_TYPES.map((t) => ({ value: t, label: IC_VERSION_TYPE_LABEL[t] }))} /></Form.Item></Col>
            <Col span={6}><Form.Item name="name" label="名称(可选)"><Input maxLength={128} /></Form.Item></Col>
            <Col span={6}><Form.Item name="approvalDocNo" label="批复文号"><Input maxLength={128} /></Form.Item></Col>
            <Col span={6}>
              <Form.Item name="approvalDate" label="批复日期" getValueProps={(x?: string) => ({ value: x ? dayjs(x) : null })} normalize={(d: dayjs.Dayjs | null) => (d ? d.format('YYYY-MM-DD') : undefined)}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
        <Space>
          <Upload accept=".xlsx,.csv" showUploadList={false} beforeUpload={(f) => { upload.mutate(f); return false; }}><Button loading={upload.isPending}>选择 .xlsx/.csv 预览</Button></Upload>
          <Button type="link" onClick={() => void download(icApi.templatePath, '投资科目导入模板.xlsx')}>下载模板</Button>
        </Space>
        {preview && <RowErrors errors={preview.errors} title="校验未通过,不能导入" />}
        {preview && preview.errorCount === 0 && (
          <>
            <Alert type="success" showIcon message={`${preview.fileName}:${preview.rowCount} 行`} description={<>一级科目静态合计 <Money value={preview.staticTotal} /> 元,动态合计 <Money value={preview.dynamicTotal} /> 元</>} />
            <Table size="small" rowKey="code" dataSource={preview.items} pagination={{ pageSize: 10 }} columns={[
              { title: '编码', dataIndex: 'code', width: 100 }, { title: '名称', dataIndex: 'name' },
              { title: '静态(元)', dataIndex: 'staticAmount', align: 'right', render: (x: string) => <Money value={x} /> },
              { title: '动态(元)', dataIndex: 'dynamicAmount', align: 'right', render: (x: string) => <Money value={x} /> },
            ]} />
          </>
        )}
      </Space>
    </Modal>
  );
}

function CompareModal({ project, open, onClose, onDone }: { project: IcProjectDetailDto; open: boolean; onClose: () => void; onDone: (c: IcComparisonDto) => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ baseVersionId: number; targetVersionId: number; normal?: string; attention?: string; warning?: string }>();
  const options = project.versions.filter((v) => v.status === 'confirmed').map((v) => ({ value: v.id, label: `${v.typeLabel} V${v.versionNo} · ${v.name}${v.isCurrent ? '(当前)' : ''}` }));
  const run = useMutation({
    mutationFn: (v: { baseVersionId: number; targetVersionId: number; normal?: string; attention?: string; warning?: string }) => icApi.compare({
      baseVersionId: v.baseVersionId, targetVersionId: v.targetVersionId,
      ...(v.normal && v.attention && v.warning ? { thresholds: { normal: v.normal, attention: v.attention, warning: v.warning } } : {}),
    }),
    onSuccess: (c) => { message.success('对比快照已生成'); onDone(c); onClose(); },
    onError: (e) => message.error(errorText(e)),
  });
  return (
    <Modal open={open} title="生成对比快照" onCancel={onClose} destroyOnClose confirmLoading={run.isPending} onOk={() => form.validateFields().then((v) => run.mutate(v))}>
      {options.length < 2 && <Alert type="info" showIcon message="至少需要两个已确认版本" style={{ marginBottom: 12 }} />}
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item name="baseVersionId" label="基准版本" rules={[{ required: true }]}><Select options={options} /></Form.Item>
        <Form.Item name="targetVersionId" label="目标版本" rules={[{ required: true }, ({ getFieldValue }) => ({ validator: (_, x) => (x && x === getFieldValue('baseVersionId') ? Promise.reject(new Error('基准与目标不能相同')) : Promise.resolve()) })]}>
          <Select options={options} />
        </Form.Item>
        <Typography.Text type="secondary">偏差率阈值(可选,缺省取业务设置「投资控制」中的默认阈值;快照记录实际使用值)</Typography.Text>
        <Row gutter={8}>
          <Col span={8}><Form.Item name="normal" label="正常 ≤" rules={[ratioRule]}><Input placeholder="0.03" /></Form.Item></Col>
          <Col span={8}><Form.Item name="attention" label="关注 ≤" rules={[ratioRule]}><Input placeholder="0.08" /></Form.Item></Col>
          <Col span={8}><Form.Item name="warning" label="预警 ≤" rules={[ratioRule]}><Input placeholder="0.10" /></Form.Item></Col>
        </Row>
      </Form>
    </Modal>
  );
}

function ProjectDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [prompt, holder] = usePrompt();
  const [importing, setImporting] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [versionId, setVersionId] = useState<number | null>(null);
  const [comparisonId, setComparisonId] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['ic-project', id], queryFn: () => icApi.project(id!), enabled: id != null });
  const comps = useQuery({ queryKey: ['ic-comparisons', id], queryFn: () => icApi.comparisons(id!), enabled: id != null });
  const p = q.data;
  const writable = can('investment:write') && p?.status === 'active';
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['ic-project', id] }); void qc.invalidateQueries({ queryKey: ['ic-projects'] }); void qc.invalidateQueries({ queryKey: ['ic-comparisons', id] }); };
  const edit = async () => {
    if (!p) return;
    const v = await prompt({ title: '编辑项目', fields: [{ name: 'approvedAmount', label: '批复投资(元,可空)', initial: p.approvedAmount ?? '' }, { name: 'approvalDocNo', label: '批复文号', initial: p.approvalDocNo }] });
    if (!v) return;
    try { await icApi.updateProject(p.id, { expectedVersion: p.version, approvedAmount: v.approvedAmount || null, approvalDocNo: v.approvalDocNo }); refresh(); } catch (e) { message.error(errorText(e)); }
  };
  const toggleArchive = async () => {
    if (!p) return;
    try { await icApi.updateProject(p.id, { expectedVersion: p.version, status: p.status === 'active' ? 'archived' : 'active' }); refresh(); } catch (e) { message.error(errorText(e)); }
  };
  return (
    <Drawer open={id != null} onClose={onClose} width={1080} destroyOnClose title={p ? `${p.code} · ${p.name}` : '投资控制项目'}
      extra={p && can('investment:write') && (
        <Space>
          {writable && <Button type="primary" onClick={() => setImporting(true)}>导入版本</Button>}
          {writable && <Button onClick={() => setComparing(true)}>生成对比</Button>}
          {writable && <Button onClick={() => void edit()}>编辑</Button>}
          <Button onClick={() => void toggleArchive()}>{p.status === 'active' ? '归档' : '恢复'}</Button>
        </Space>
      )}>
      {holder}
      {q.error ? <QueryErrorResult title="项目加载失败" error={q.error} refetch={q.refetch} /> : !p ? null : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Descriptions size="small" column={3} bordered>
            <Descriptions.Item label="组织">{p.orgName}</Descriptions.Item>
            <Descriptions.Item label="批复投资(元)"><Money value={p.approvedAmount} /></Descriptions.Item>
            <Descriptions.Item label="批复文号">{p.approvalDocNo || '—'}</Descriptions.Item>
            <Descriptions.Item label="红线(元)" span={3}>{p.redlineAmount ? <><Money value={p.redlineAmount} />(版本 #{p.redlineVersionId})</> : '未确认设计/调整概算'}</Descriptions.Item>
          </Descriptions>
          <Tabs items={[
            {
              key: 'versions', label: `版本(${p.versions.length})`,
              children: (
                <Table<IcVersionSummaryDto> rowKey="id" size="small" dataSource={p.versions} pagination={false} locale={{ emptyText: <Empty description="还没有版本,请导入投资科目表" /> }}
                  onRow={(v) => ({ onClick: () => setVersionId(v.id), style: { cursor: 'pointer' } })} columns={[
                    { title: '类型', dataIndex: 'typeLabel', width: 110 },
                    { title: '版本', dataIndex: 'versionNo', width: 60, render: (x: number) => `V${x}` },
                    { title: '名称', dataIndex: 'name' },
                    { title: '状态', dataIndex: 'status', width: 150, render: (x: string, v) => <Space size={2}>{statusTag(IC_VERSION_STATUS, x)}{v.isCurrent && <Tag color="blue">当前</Tag>}{v.isRedline && <Tag color="red">红线</Tag>}</Space> },
                    { title: '静态(元)', dataIndex: 'staticTotal', width: 150, align: 'right', render: (x: string) => <Money value={x} /> },
                    { title: '动态(元)', dataIndex: 'dynamicTotal', width: 150, align: 'right', render: (x: string) => <Money value={x} /> },
                    { title: '待映射', key: 'need', width: 80, render: (_: unknown, v) => (v.mappingCounts.need_mapping ? <Tag color="error">{v.mappingCounts.need_mapping}</Tag> : 0) },
                    { title: '创建', dataIndex: 'createdAt', width: 130, render: (x: string) => shortTime(x) },
                  ]} />
              ),
            },
            {
              key: 'comparisons', label: `对比快照(${comps.data?.items.length ?? 0})`,
              children: (
                <Table<IcComparisonDto> rowKey="id" size="small" loading={comps.isLoading} dataSource={comps.data?.items ?? []} pagination={false}
                  locale={{ emptyText: <Empty description="还没有对比快照" /> }}
                  onRow={(c) => ({ onClick: () => setComparisonId(c.id), style: { cursor: 'pointer' } })} columns={[
                    { title: '#', dataIndex: 'id', width: 60 },
                    { title: '基准 → 目标', key: 'vs', render: (_: unknown, c) => `${c.base.typeLabel} V${c.base.versionNo} → ${c.target.typeLabel} V${c.target.versionNo}` },
                    { title: '偏差(元)', key: 'dev', width: 150, align: 'right', render: (_: unknown, c) => <Money value={c.summary.totalDeviation} tone /> },
                    { title: '偏差率', key: 'rate', width: 100, align: 'right', render: (_: unknown, c) => <Ratio value={c.summary.totalDeviationRate} /> },
                    { title: '等级', key: 'lv', width: 80, render: (_: unknown, c) => statusTag(IC_LEVEL, c.summary.totalLevel) },
                    { title: '控制链', key: 'chain', width: 200, render: (_: unknown, c) => (c.summary.controlChain.length ? c.summary.controlChain.map((x) => <Tag key={x.status} color="red">{x.message}</Tag>) : <Tag color="success">无突破</Tag>) },
                    { title: '时间', dataIndex: 'createdAt', width: 130, render: (x: string) => shortTime(x) },
                  ]} />
              ),
            },
          ]} />
          <ImportModal project={p} open={importing} onClose={() => setImporting(false)} onDone={(vid) => { refresh(); setVersionId(vid); }} />
          <CompareModal project={p} open={comparing} onClose={() => setComparing(false)} onDone={(c) => { refresh(); setComparisonId(c.id); }} />
        </Space>
      )}
      <VersionDrawer id={versionId} onClose={() => setVersionId(null)} />
      <ComparisonModal id={comparisonId} onClose={() => setComparisonId(null)} />
    </Drawer>
  );
}

function CreateModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (p: IcProjectDto) => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ mdProjectId: number; approvedAmount?: string; approvalDocNo?: string }>();
  const masters = useQuery({ queryKey: ['master-options', 'projects'], queryFn: () => api.get<MasterOption[]>('/master/projects'), enabled: open, staleTime: 60_000 });
  const save = useMutation({
    mutationFn: (v: { mdProjectId: number; approvedAmount?: string; approvalDocNo?: string }) => icApi.createProject(compact(v) as { mdProjectId: number }),
    onSuccess: (p) => { message.success(`已建立投资控制项目 ${p.code}`); onDone(p); onClose(); },
    onError: (e) => message.error(errorText(e)),
  });
  return (
    <Modal open={open} title="新建投资控制项目" onCancel={onClose} destroyOnClose confirmLoading={save.isPending} onOk={() => form.validateFields().then((v) => save.mutate(v))}>
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item name="mdProjectId" label="主数据项目" rules={[{ required: true, message: '请选择项目' }]} extra="组织取主数据项目的组织;同一项目只能建一次">
          <Select showSearch optionFilterProp="label" loading={masters.isLoading} options={(masters.data ?? []).map((m) => ({ value: m.id, label: `${m.name}${m.code ? `(${m.code})` : ''}` }))} />
        </Form.Item>
        <Form.Item name="approvedAmount" label="批复投资(元,可选)" rules={[{ pattern: /^\d{1,16}(\.\d{1,2})?$/, message: '最多 2 位小数的非负金额' }]}><Input /></Form.Item>
        <Form.Item name="approvalDocNo" label="批复文号"><Input maxLength={128} /></Form.Item>
      </Form>
    </Modal>
  );
}

export default function InvestmentControl() {
  const [orgId, setOrgId] = useState<number>();
  const [status, setStatus] = useState<'active' | 'archived' | undefined>('active');
  const [keyword, setKeyword] = useState('');
  const [openId, setOpenId] = useUrlId();
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();
  const query = compact({ orgId, status, keyword: keyword.trim() });
  const list = useQuery({ queryKey: ['ic-projects', query], queryFn: () => icApi.projects(query) });
  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <OrgSelect value={orgId} onChange={setOrgId} />
        <Select allowClear placeholder="状态" style={{ width: 110 }} value={status} onChange={setStatus} options={[{ value: 'active', label: '进行中' }, { value: 'archived', label: '已归档' }]} />
        <Input.Search allowClear placeholder="编码/名称" style={{ width: 200 }} onSearch={setKeyword} />
        {can('investment:write') && <Button type="primary" onClick={() => setCreating(true)}>新建项目</Button>}
        <Button onClick={() => void download(icApi.templatePath, '投资科目导入模板.xlsx')}>下载导入模板</Button>
      </Space>
      {list.error ? <QueryErrorResult title="项目列表加载失败" error={list.error} refetch={list.refetch} /> : (
        <Table<IcProjectDto> rowKey="id" size="small" loading={list.isLoading} dataSource={list.data?.items ?? []} scroll={{ x: 1200 }}
          locale={{ emptyText: <Empty description="还没有投资控制项目" /> }}
          onRow={(p) => ({ onClick: () => setOpenId(p.id), style: { cursor: 'pointer' } })} columns={[
            { title: '编码', dataIndex: 'code', width: 120 },
            { title: '名称', dataIndex: 'name' },
            { title: '组织', dataIndex: 'orgName', width: 120 },
            { title: '红线(元)', dataIndex: 'redlineAmount', width: 150, align: 'right', render: (x: string | null) => <Money value={x} /> },
            ...(['estimate', 'design_estimate', 'construction_budget', 'settlement'] as const).map((t) => ({
              title: `${IC_VERSION_TYPE_LABEL[t]}(元)`, key: t, width: 150, align: 'right' as const,
              render: (_: unknown, p: IcProjectDto) => <Money value={p.current[t]?.staticTotal ?? null} />,
            })),
            { title: '状态', dataIndex: 'status', width: 80, render: (x: string) => (x === 'active' ? <Tag color="processing">进行中</Tag> : <Tag>已归档</Tag>) },
          ]} />
      )}
      <CreateModal open={creating} onClose={() => setCreating(false)} onDone={(p) => { void qc.invalidateQueries({ queryKey: ['ic-projects'] }); setOpenId(p.id); }} />
      <ProjectDrawer id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
