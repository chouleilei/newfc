/**
 * 「新增财务数据源」的结构化配置表单(方案 3.5)。
 *
 * 原实现直接给一个 rows=14 的裸 JSON TextArea,用户得手写 `sourceAccountIncludePrefixes`
 * 之类的键名,拼错无提示、也无从校验。这里把 config 的固定键拆成对应控件,
 * 底部只读展示实时生成的 JSON 预览。
 *
 * **提交载荷必须与现状完全一致**(同一 JSON schema,后端接口零改动):
 * 表单值 ↔ config 对象的双向映射收敛在 toConfig / toFormValues 两个纯函数里,
 * 并有单测逐键比对默认载荷,防止结构化改造悄悄改掉后端契约。
 */
import { useEffect } from 'react';
import { Collapse, Form, Input, InputNumber, Select, Space, Typography } from 'antd';
import { useWatch } from 'antd/es/form/Form';

/** 余额表版式:单表头(一行表头)/ 双表头(两行表头) */
const BALANCE_LAYOUTS = [
  { value: 'single_header', label: '单表头（一行表头）' },
  { value: 'double_header', label: '双表头（两行表头）' },
];

/** 金额单位:元 / 万元(解析时按此换算成分) */
const AMOUNT_UNITS = [
  { value: 'yuan', label: '元' },
  { value: 'wan', label: '万元' },
];

/** 与后端声明式适配器约定的默认配置(键集合与默认值均不得改动) */
export const DEFAULT_SOURCE_CONFIG = {
  balanceSheetNames: ['科目余额表'],
  profitSheetNames: ['利润表'],
  journalSheetNames: ['凭证序时簿'],
  balanceLayout: 'single_header',
  sourceAccountIncludePrefixes: [] as string[],
  ownedOrgCodes: [] as string[],
  ownedAccountCodes: [] as string[],
  amountUnit: 'yuan',
  maxRows: 20000,
  maxOutputBytes: 10485760,
};

interface FormValues {
  code: string;
  name: string;
  balanceSheetNames: string[];
  profitSheetNames: string[];
  journalSheetNames: string[];
  balanceLayout: string;
  amountUnit: string;
  maxRows: number;
  maxOutputBytes: number;
  sourceAccountIncludePrefixes: string[];
  ownedOrgCodes: string[];
  ownedAccountCodes: string[];
}

/** 表单值 -> config 对象。键序与默认配置一致,保证 JSON.stringify 输出稳定。 */
export function toConfig(v: FormValues) {
  return {
    balanceSheetNames: v.balanceSheetNames ?? [],
    profitSheetNames: v.profitSheetNames ?? [],
    journalSheetNames: v.journalSheetNames ?? [],
    balanceLayout: v.balanceLayout,
    sourceAccountIncludePrefixes: v.sourceAccountIncludePrefixes ?? [],
    ownedOrgCodes: v.ownedOrgCodes ?? [],
    ownedAccountCodes: v.ownedAccountCodes ?? [],
    amountUnit: v.amountUnit,
    maxRows: Number(v.maxRows),
    maxOutputBytes: Number(v.maxOutputBytes),
  };
}

/** config 对象 -> 表单值(打开弹窗时的初始值) */
export function toFormValues(config: Partial<typeof DEFAULT_SOURCE_CONFIG> = DEFAULT_SOURCE_CONFIG): FormValues {
  return {
    code: '',
    name: '',
    balanceSheetNames: config.balanceSheetNames ?? DEFAULT_SOURCE_CONFIG.balanceSheetNames,
    profitSheetNames: config.profitSheetNames ?? DEFAULT_SOURCE_CONFIG.profitSheetNames,
    journalSheetNames: config.journalSheetNames ?? DEFAULT_SOURCE_CONFIG.journalSheetNames,
    balanceLayout: config.balanceLayout ?? DEFAULT_SOURCE_CONFIG.balanceLayout,
    amountUnit: config.amountUnit ?? DEFAULT_SOURCE_CONFIG.amountUnit,
    maxRows: config.maxRows ?? DEFAULT_SOURCE_CONFIG.maxRows,
    maxOutputBytes: config.maxOutputBytes ?? DEFAULT_SOURCE_CONFIG.maxOutputBytes,
    sourceAccountIncludePrefixes: config.sourceAccountIncludePrefixes ?? [],
    ownedOrgCodes: config.ownedOrgCodes ?? [],
    ownedAccountCodes: config.ownedAccountCodes ?? [],
  };
}

/** 逗号/换行/空格分隔的文本 -> 字符串数组(空输入得空数组,与默认载荷一致) */
const splitList = (text: string | null | undefined): string[] =>
  (text ?? '')
    .split(/[,，\n\r\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** 字符串数组 -> 展示文本 */
const joinList = (list: string[] | null | undefined): string => (list ?? []).join(', ');

/** 生成只读预览用的格式化 JSON */
export function configJson(v: FormValues): string {
  return JSON.stringify(toConfig(v), null, 2);
}

/**
 * 表单体。提交由外层 Modal 的 onOk 驱动:
 * validateFields() 拿到的仍是 { code, name, config } 同一载荷 —— config 字段由
 * 隐藏 Form.Item 承载,值随上方控件实时重算,因此后端契约与提交路径均不变。
 */
export function SourceProfileForm({ form }: { form: any }) {
  const values = useWatch([], form) as FormValues | undefined;

  /**
   * 把上方控件的值实时写回隐藏的 config 字段。
   * 只写 config 自身,不触发 onValuesChange 递归(Form.Item 的 hidden 字段不参与校验展示)。
   */
  useEffect(() => {
    if (!values) return;
    form.setFieldValue('config', JSON.stringify(toConfig(values), null, 2));
  }, [form, values]);

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={{
        ...toFormValues(),
        config: JSON.stringify(DEFAULT_SOURCE_CONFIG, null, 2),
      }}
    >
      <Form.Item name="code" label="数据源编码" rules={[{ required: true }]}>
        <Input placeholder="如 finance_main" />
      </Form.Item>
      <Form.Item name="name" label="名称" rules={[{ required: true }]}>
        <Input placeholder="如 集团主账套" />
      </Form.Item>

      <Space size={12} style={{ display: 'flex' }} align="start">
        <Form.Item
          name="balanceSheetNames"
          label="余额表工作表名"
          style={{ flex: 1 }}
          tooltip="可填多个,命中任一即识别为余额表"
          rules={[{ required: true, message: '至少填写一个余额表名' }]}
        >
          <Select mode="tags" placeholder="回车分隔多个表名" tokenSeparators={[',', '，']} />
        </Form.Item>
        <Form.Item
          name="profitSheetNames"
          label="利润表工作表名"
          style={{ flex: 1 }}
          rules={[{ required: true, message: '至少填写一个利润表名' }]}
        >
          <Select mode="tags" placeholder="回车分隔多个表名" tokenSeparators={[',', '，']} />
        </Form.Item>
      </Space>

      <Form.Item name="journalSheetNames" label="凭证序时簿工作表名" tooltip="可选;数据源可设为必传">
        <Select mode="tags" placeholder="回车分隔多个表名" tokenSeparators={[',', '，']} />
      </Form.Item>

      <Space size={12} style={{ display: 'flex' }} align="start">
        <Form.Item name="balanceLayout" label="余额表版式" style={{ flex: 1 }} rules={[{ required: true }]}>
          <Select options={BALANCE_LAYOUTS} />
        </Form.Item>
        <Form.Item name="amountUnit" label="源文件金额单位" style={{ flex: 1 }} rules={[{ required: true }]}>
          <Select options={AMOUNT_UNITS} />
        </Form.Item>
      </Space>

      <Space size={12} style={{ display: 'flex' }} align="start">
        <Form.Item name="maxRows" label="最大解析行数" style={{ flex: 1 }} rules={[{ required: true }]}>
          <InputNumber min={1} max={1_000_000} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="maxOutputBytes" label="输出文件上限(字节)" style={{ flex: 1 }} rules={[{ required: true }]}>
          <InputNumber min={1024} step={1048576} style={{ width: '100%' }} />
        </Form.Item>
      </Space>

      <Form.Item
        name="sourceAccountIncludePrefixes"
        label="源科目前缀白名单"
        tooltip="留空表示不过滤。逗号或换行分隔,如 6001,6051"
      >
        <Select mode="tags" placeholder="留空则包含全部科目" tokenSeparators={[',', '，']} open={false} />
      </Form.Item>

      <Space size={12} style={{ display: 'flex' }} align="start">
        <Form.Item
          name="ownedOrgCodes"
          label="拥有范围:组织编码"
          style={{ flex: 1 }}
          tooltip="留空表示拥有全部。范围外的行会被判为范围外非零并排除"
        >
          <Select mode="tags" placeholder="留空则拥有全部组织" tokenSeparators={[',', '，']} open={false} />
        </Form.Item>
        <Form.Item name="ownedAccountCodes" label="拥有范围:科目编码" style={{ flex: 1 }}>
          <Select mode="tags" placeholder="留空则拥有全部科目" tokenSeparators={[',', '，']} open={false} />
        </Form.Item>
      </Space>

      {/* 隐藏字段:承载与后端契约一致的 config JSON,使提交路径与载荷完全不变 */}
      <Form.Item name="config" hidden>
        <Input.TextArea />
      </Form.Item>

      <Collapse
        ghost
        items={[{
          key: 'json',
          label: <Typography.Text type="secondary" style={{ fontSize: 12 }}>查看将提交的 JSON（只读）</Typography.Text>,
          children: (
            <pre
              style={{
                margin: 0,
                padding: 12,
                borderRadius: 6,
                fontSize: 12,
                lineHeight: 1.7,
                maxHeight: 240,
                overflow: 'auto',
                background: 'var(--newfc-bg-fill)',
                border: '1px solid var(--newfc-border-subtle)',
                color: 'var(--newfc-text-secondary)',
                fontFamily: "'IBM Plex Sans', Roboto, monospace",
              }}
            >
              {values ? configJson(values) : ''}
            </pre>
          ),
        }]}
      />
    </Form>
  );
}

/** 供外部按需复用:把逗号分隔文本归一为数组(导出仅为测试与后续编辑态复用) */
export { splitList, joinList };
