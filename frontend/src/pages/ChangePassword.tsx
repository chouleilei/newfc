import { useState } from 'react';
import { Alert, Button, Form, Input, Typography } from 'antd';
import { api, errorText } from '../api/client';
import { BrandLogo } from '../components/BrandLogo';

interface ChangePasswordForm {
  currentPassword: string;
  newPassword: string;
  confirm: string;
}

/** 改口令:管理员新建/重置账号后首次登录强制进入;也可从用户菜单主动进入 */
export default function ChangePassword({ forced, username, onDone, onCancel }: {
  forced: boolean;
  username: string;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (values: ChangePasswordForm) => {
    setLoading(true);
    setError('');
    try {
      await api.post('/me/password', { currentPassword: values.currentPassword, newPassword: values.newPassword });
      onDone();
    } catch (e) {
      setError(errorText(e, { fallback: '修改失败,请稍后重试' }));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bd-login">
      <div className="bd-login-card">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <BrandLogo size={44} />
          <Typography.Title level={4} style={{ marginBottom: 0 }}>修改口令</Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {forced ? `账号 ${username} 使用的是管理员设置的初始口令,请先修改后继续` : `当前账号 ${username}`}
          </Typography.Text>
        </div>
        <Form<ChangePasswordForm> layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item name="currentPassword" label="当前口令" rules={[{ required: true, message: '请输入当前口令' }]}>
            <Input.Password autoComplete="current-password" size="large" autoFocus />
          </Form.Item>
          <Form.Item
            name="newPassword"
            label="新口令"
            extra="至少 10 位,不能包含用户名,不能与当前口令相同"
            rules={[{ required: true, message: '请输入新口令' }, { min: 10, message: '至少 10 位' }, { max: 128, message: '最多 128 位' }]}
          >
            <Input.Password autoComplete="new-password" size="large" />
          </Form.Item>
          <Form.Item
            name="confirm"
            label="确认新口令"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: '请再次输入新口令' },
              ({ getFieldValue }) => ({
                validator: (_, value) => value === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('两次输入不一致')),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" size="large" />
          </Form.Item>
          {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
          <Button type="primary" htmlType="submit" block size="large" loading={loading}>确认修改</Button>
          {onCancel && <Button type="link" block style={{ marginTop: 8 }} onClick={onCancel}>{forced ? '退出登录' : '返回'}</Button>}
        </Form>
      </div>
    </div>
  );
}
