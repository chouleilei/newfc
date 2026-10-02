import { useState } from 'react';
import { Alert, Button, Form, Input, Typography } from 'antd';
import { api, setSession, type SessionInfo } from '../api/client';
import { BrandLogo } from '../components/BrandLogo';

interface LoginForm {
  username: string;
  password: string;
}

/** 登录页:墨账封面 + 朱红光斑(年度账册) + 单张白卡,成功后由 App 接管进入主界面 */
export default function Login({ onSuccess }: { onSuccess: (session: SessionInfo) => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (values: LoginForm) => {
    setLoading(true);
    setError('');
    try {
      const session = await api.post<SessionInfo>('/auth/login', values);
      setSession(session);
      onSuccess(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败,请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="newfc-login">
      <div className="newfc-login-card">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, marginBottom: 28 }}>
          <BrandLogo size={52} />
          <div style={{ textAlign: 'center' }}>
            <Typography.Title level={4} style={{ marginBottom: 2 }}>
              水利财务分析
            </Typography.Title>
            <Typography.Text type="secondary" className="newfc-brand-sub" style={{ fontSize: 12 }}>
              newfc Finance Console
            </Typography.Text>
          </div>
        </div>

        <Form<LoginForm> layout="vertical" onFinish={submit} autoComplete="on" requiredMark={false}>
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input prefix={<i className="ri-user-3-line" style={{ opacity: 0.45 }} aria-hidden />} placeholder="用户名" size="large" autoFocus />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password prefix={<i className="ri-lock-2-line" style={{ opacity: 0.45 }} aria-hidden />} placeholder="密码" size="large" />
          </Form.Item>
          {error && (
            <Alert
              type="error"
              message={error}
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}
          <Button type="primary" htmlType="submit" block size="large" loading={loading}>
            登 录
          </Button>
        </Form>

        <Typography.Text
          type="secondary"
          style={{ display: 'block', textAlign: 'center', fontSize: 12, marginTop: 24, opacity: 0.7 }}
        >
          请使用管理员分配的账号登录，无法登录时请联系管理员。
        </Typography.Text>
      </div>
    </div>
  );
}
