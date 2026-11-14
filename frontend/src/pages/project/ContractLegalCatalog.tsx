import { ContractLegalPublishForm } from './ContractLegalPublishForm';
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  App,
  Button,
  Collapse,
  Drawer,
  Empty,
  Input,
  Modal,
  Space,
  Tabs,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { contractApi } from '../../api/projectContract';
import { can, download, errorText, getSession } from '../../api/client';
export function resolveCatalogDownloadFileName(item: {
  code: string;
  originalFileName?: string | null;
  contentType?: string | null;
}): string {
  const orig = (item.originalFileName ?? '').trim();
  const extMatch = orig.match(/(\.[A-Za-z0-9]{2,8})$/);
  let ext = extMatch ? extMatch[1].toLowerCase() : '';
  if (!ext) {
    const ct = (item.contentType ?? '').toLowerCase();
    if (ct.includes('application/pdf')) ext = '.pdf';
    else if (ct.includes('application/msword')) ext = '.doc';
    else ext = '.docx';
  }
  return item.code.toLowerCase().endsWith(ext) ? item.code : `${item.code}${ext}`;
}

export function ContractLegalCatalog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const [kind, setKind] = useState<'policies' | 'templates'>('policies');
  const [publish, setPublish] = useState(false);
  const [command, setCommand] = useState<{
    id: number;
    action: 'promote' | 'retire';
  }>();
  const [reason, setReason] = useState('');
  const ps = useQuery({
    queryKey: ['contract-legal-policies'],
    queryFn: contractApi.legalPolicies,
    enabled: open,
  });
  const ts = useQuery({
    queryKey: ['contract-legal-templates'],
    queryFn: contractApi.legalTemplates,
    enabled: open,
  });
  const action = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      void ps.refetch();
      void ts.refetch();
      setCommand(undefined);
      setPublish(false);
      setReason('');
      message.success('已保存版本操作');
    },
    onError: (e) => message.error(errorText(e)),
  });
  const manage = can('knowledge:manage') && !!getSession()?.user.allOrgs;
  const q = kind === 'policies' ? ps : ts;
  const rows = q.data ?? [];
  return (
    <Drawer title="法审制度与范本" open={open} onClose={onClose} width={900}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Typography.Paragraph>
          条款发布后冻结。修改条款请发布新版本；候选范本经主管部门核定后转正。历史审核仍保留原始依据。
        </Typography.Paragraph>
        <Tabs
          activeKey={kind}
          onChange={(v) => setKind(v as typeof kind)}
          items={[
            { key: 'policies', label: '现行制度' },
            { key: 'templates', label: '合同范本' },
          ]}
        />
        {manage && (
          <Button
            onClick={() => {
              setPublish(true);
            }}
          >
            发布新版本
          </Button>
        )}
        {q.error && (
          <div role="alert">
            {errorText(q.error)}{' '}
            <Button onClick={() => void q.refetch()}>重试</Button>
          </div>
        )}
        {!rows.length && (
          <Empty
            description={
              q.isLoading ? '正在读取' : '尚无版本，请导入种子或发布新版本'
            }
          />
        )}
        <Collapse
          items={rows.map((r) => ({
            key: r.id,
            label: (
              <Space wrap>
                <span>
                  {r.code} v{r.version} · {'title' in r ? r.title : r.name}
                </span>
                <Tag>{'status' in r ? r.status : r.approvalStatus}</Tag>
              </Space>
            ),
            children: (
              <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Paragraph>
                  {'sourceNote' in r ? r.sourceNote : r.notes}
                </Typography.Paragraph>
                <Space wrap>
                  {getSession()?.user.allOrgs && r.sourceFileObjectId && (
                    <Button
                      onClick={() =>
                        void download(
                          `/contracts/legal-catalog/${kind}/${r.id}/source`,
                          resolveCatalogDownloadFileName(r),
                        )
                      }
                    >
                      下载原件
                    </Button>
                  )}
                  {manage && (
                    <>
                      <Upload
                        accept=".docx,.pdf,.doc"
                        showUploadList={false}
                        beforeUpload={(f) => {
                          action.mutate(() =>
                            contractApi.legalSource(kind, r.id, f),
                          );
                          return false;
                        }}
                      >
                        <Button>关联原件</Button>
                      </Upload>
                      {'approvalStatus' in r &&
                        r.approvalStatus === 'candidate' && (
                          <Button
                            onClick={() =>
                              setCommand({ id: r.id, action: 'promote' })
                            }
                          >
                            核定转正
                          </Button>
                        )}
                      {('status' in r ? r.status : r.approvalStatus) !==
                        'retired' && (
                        <Button
                          danger
                          onClick={() =>
                            setCommand({ id: r.id, action: 'retire' })
                          }
                        >
                          停用版本
                        </Button>
                      )}
                    </>
                  )}
                </Space>
                {r.clauses.map((c) => (
                  <div
                    key={c.id}
                    style={{
                      borderTop: '1px solid var(--newfc-border, #e5ded0)',
                      paddingTop: 12,
                      overflowWrap: 'anywhere',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    <Typography.Text strong>
                      {c.clauseNo} ·{' '}
                      {'chapterTitle' in c ? c.chapterTitle : c.title}
                    </Typography.Text>
                    {'tier' in c && (
                      <Tag>
                        {
                          {
                            fixed: '固定条款',
                            default_ref: '默认参考值',
                            placeholder: '项目填写项',
                          }[c.tier]
                        }
                      </Tag>
                    )}
                    <p>{'clauseText' in c ? c.clauseText : c.standardText}</p>
                  </div>
                ))}
              </Space>
            ),
          }))}
        />
      </Space>
      <Modal
        open={!!command}
        title={
          command?.action === 'promote' ? '核定范本为正式版本' : '停用此版本'
        }
        onCancel={() => setCommand(undefined)}
        confirmLoading={action.isPending}
        onOk={() => {
          if (!reason.trim()) return message.warning('请填写核定或停用说明');
          action.mutate(() =>
            contractApi.changeLegal(kind, command!.id, command!.action, reason),
          );
        }}
      >
        <Input.TextArea
          aria-label="核定或停用说明"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={2000}
          rows={4}
        />
      </Modal>
      <ContractLegalPublishForm
        key={kind}
        kind={kind}
        open={publish}
        busy={action.isPending}
        onCancel={() => setPublish(false)}
        onSave={(body) =>
          action.mutate(() => contractApi.publishLegal(kind, body))
        }
      />
    </Drawer>
  );
}
