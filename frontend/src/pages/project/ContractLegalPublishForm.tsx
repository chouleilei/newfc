import {
  Button,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
} from 'antd';
import { LEGAL_CATEGORIES, LEGAL_LABELS } from './contractLegalOptions';
/** A version is a business document; administrators edit named fields and clauses. */
export function ContractLegalPublishForm({
  open,
  kind,
  busy,
  onCancel,
  onSave,
}: {
  open: boolean;
  kind: 'policies' | 'templates';
  busy: boolean;
  onCancel: () => void;
  onSave: (body: unknown) => void;
}) {
  const [form] = Form.useForm();
  const policy = kind === 'policies';
  const field = (name: string, label: string, multiline = false) => (
    <Form.Item
      name={name}
      label={label}
      rules={[{ required: true, message: `请填写${label}` }]}
    >
      {multiline ? (
        <Input.TextArea rows={3} maxLength={2000} />
      ) : (
        <Input maxLength={200} />
      )}
    </Form.Item>
  );
  return (
    <Modal
      title={policy ? '发布制度新版本' : '发布范本新版本'}
      open={open}
      width={820}
      destroyOnClose
      onCancel={onCancel}
      confirmLoading={busy}
      onOk={() =>
        void form.validateFields().then((v) =>
          onSave({
            ...v,
            ...(policy
              ? { effectiveFrom: v.effectiveFrom.format('YYYY-MM-DD') }
              : {}),
            clauses: v.clauses.map((c: Record<string, unknown>) =>
              policy
                ? {
                    ...c,
                    ruleTags:
                      typeof c.ruleTags === 'string'
                        ? c.ruleTags.split(/[，,\s]+/).filter(Boolean)
                        : [],
                  }
                : {
                    ...c,
                    placeholderKeys:
                      typeof c.placeholderKeys === 'string'
                        ? c.placeholderKeys
                            .split(/[，,]+/)
                            .map((s) => s.trim())
                            .filter(Boolean)
                        : [],
                  },
            ),
          }),
        )
      }
    >
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={{
          version: 1,
          approvalStatus: 'candidate',
          legalCategory: 'goods_procurement',
          clauses: [policy ? {} : { tier: 'placeholder' }],
        }}
      >
        <Row gutter={16}>
          <Col xs={24} sm={16}>
            {field('code', '制度 / 范本编码')}
          </Col>
          <Col xs={24} sm={8}>
            <Form.Item
              name="version"
              label="版本号"
              rules={[{ required: true }]}
            >
              <InputNumber min={1} precision={0} />
            </Form.Item>
          </Col>
        </Row>
        {policy ? (
          <>
            {field('title', '制度名称')}
            {field('docNo', '印发文号')}
            <Form.Item
              name="effectiveFrom"
              label="生效日期"
              rules={[{ required: true }]}
            >
              <DatePicker />
            </Form.Item>
            {field('sourceNote', '来源与核对说明', true)}
          </>
        ) : (
          <>
            {field('name', '范本名称')}
            <Row gutter={16}>
              <Col xs={24} sm={12}>
                <Form.Item
                  name="legalCategory"
                  label="法审大类"
                  rules={[{ required: true }]}
                >
                  <Select
                    options={LEGAL_CATEGORIES.map(value => ({ value, label: LEGAL_LABELS[value] }))}
                  />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12}>
                <Form.Item name="approvalStatus" label="核定状态">
                  <Select
                    options={[
                      { value: 'candidate', label: '候选（待核定）' },
                      {
                        value: 'official',
                        label: '已正式核定（须在说明中记录依据）',
                      },
                    ]}
                  />
                </Form.Item>
              </Col>
            </Row>
            {field('notes', '核定依据与适用范围', true)}
          </>
        )}
        <Form.List
          name="clauses"
          rules={[
            {
              validator: async (_, v) => {
                if (!v?.length) throw new Error('至少添加一条条款');
              },
            },
          ]}
        >
          {(fields, { add, remove }, { errors }) => (
            <Space direction="vertical" style={{ width: '100%' }}>
              {fields.map(({ key, name, ...rest }, i) => (
                <div
                  key={key}
                  style={{
                    borderTop: '1px solid var(--newfc-border, #e5ded0)',
                    paddingTop: 16,
                  }}
                >
                  <Row gutter={12}>
                    <Col xs={24} sm={6}>
                      <Form.Item
                        {...rest}
                        name={[name, 'clauseNo']}
                        label="条款编号"
                        rules={[{ required: true }]}
                      >
                        <Input maxLength={60} placeholder="如 5.1 / 第五条" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={18}>
                      <Form.Item
                        {...rest}
                        name={[name, policy ? 'chapterTitle' : 'title']}
                        label="条款名称"
                        rules={[{ required: true }]}
                      >
                        <Input maxLength={200} />
                      </Form.Item>
                    </Col>
                    {!policy && (
                      <>
                        <Col xs={24} sm={12}>
                          <Form.Item
                            {...rest}
                            name={[name, 'clauseKey']}
                            label="条款识别码"
                            rules={[{ required: true }]}
                          >
                            <Input
                              maxLength={80}
                              placeholder="本版本内唯一，如 payment"
                            />
                          </Form.Item>
                        </Col>
                        <Col xs={24} sm={12}>
                          <Form.Item
                            {...rest}
                            name={[name, 'tier']}
                            label="条款层次"
                            rules={[{ required: true }]}
                          >
                            <Select
                              options={[
                                { value: 'fixed', label: '固定条款' },
                                { value: 'default_ref', label: '默认参考值' },
                                { value: 'placeholder', label: '项目填写项' },
                              ]}
                            />
                          </Form.Item>
                        </Col>
                      </>
                    )}
                    <Col span={24}>
                      <Form.Item
                        {...rest}
                        name={[name, policy ? 'clauseText' : 'standardText']}
                        label="条款原文"
                        rules={[{ required: true }]}
                      >
                        <Input.TextArea rows={4} maxLength={16000} />
                      </Form.Item>
                    </Col>
                    {policy ? (
                      <Col span={24}>
                        <Form.Item
                          {...rest}
                          name={[name, 'ruleTags']}
                          label="适用规则标签（逗号分隔，可空）"
                        >
                          <Input placeholder="elements, signing, important, effective, termination, number, procurement" />
                        </Form.Item>
                      </Col>
                    ) : (
                      <>
                        <Col span={24}>
                          <Form.Item
                            {...rest}
                            name={[name, 'defaultValueNote']}
                            label="默认值说明"
                          >
                            <Input maxLength={2000} />
                          </Form.Item>
                        </Col>
                        <Col xs={24} sm={12}>
                          <Form.Item
                            {...rest}
                            name={[name, 'placeholderKeys']}
                            label="项目填写项（逗号分隔）"
                          >
                            <Input />
                          </Form.Item>
                        </Col>
                        <Col xs={24} sm={12}>
                          <Form.Item
                            {...rest}
                            name={[name, 'policyClauseRef']}
                            label="依据制度条款 ID（可空）"
                          >
                            <InputNumber min={1} precision={0} />
                          </Form.Item>
                        </Col>
                      </>
                    )}
                  </Row>
                  <Button danger onClick={() => remove(name)}>
                    移除条款 {i + 1}
                  </Button>
                </div>
              ))}
              <Form.ErrorList errors={errors} />
              <Button
                onClick={() => add(policy ? {} : { tier: 'placeholder' })}
              >
                添加条款
              </Button>
            </Space>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
}
