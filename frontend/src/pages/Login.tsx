import { useState } from 'react';
import { Alert, Button, Form, Input, Typography } from 'antd';
import { api, setToken } from '../api/client';
import { BrandLogo } from '../components/BrandLogo';

interface LoginForm {
  username: string;
  password: string;
}

/** 登录页:墨账封面 + 朱红光斑(年度账册) + 单张白卡,成功后由 App 接管进入主界面 */
export default function Login({ onSuccess }: { onSuccess: (username: string) => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (values: LoginForm) => {
    setLoading(true);
    setError('');
    try {
      const res = await api.post<{ authEnabled: boolean; token?: string; username?: string }>('/auth/login', values);
      if (res.token) setToken(res.token);
      onSuccess(res.username ?? values.username);
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败,请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bd-login">
      <div className="bd-login-card">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, marginBottom: 28 }}>
          <BrandLogo size={52} />
          <div style={{ textAlign: 'center' }}>
            <Typography.Title level={4} style={{ marginBottom: 2 }}>
              年度预算管理
            </Typography.Title>
            <Typography.Text type="secondary" className="bd-brand-sub" style={{ fontSize: 12 }}>
              Budget Console
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
          集团多组织年度预算管理系统
        </Typography.Text>
      </div>
    </div>
  );
}
