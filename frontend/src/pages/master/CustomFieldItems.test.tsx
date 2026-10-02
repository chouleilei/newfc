// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Button, Form } from 'antd';
import { CustomFieldItems } from './CustomFieldItems';
import type { CustomFieldDto } from '../../api/systemSettings';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) });
});
afterEach(cleanup);

/** AC-F23:自定义控件必须参与 Form 值绑定,并通过标签定位到实际输入,不能只显示字段。 */
it('项目扩展字段可按标签录入并提交精确数值、日期与字典取值', async () => {
  const onFinish = vi.fn();
  const field = (fieldCode: string, fieldName: string, fieldType: CustomFieldDto['fieldType']): CustomFieldDto => ({
    id: 1, domain: 'project', fieldCode, fieldName, fieldType, required: false, dictType: fieldType === 'select' ? 'stage' : null,
    description: '', sortOrder: 0, status: 'active', version: 1, createdAt: '', updatedAt: '',
    ...(fieldType === 'select' ? { options: [{ value: 'design', label: '设计' }, { value: 'build', label: '施工' }] } : {}),
  });
  render(
    <Form layout="vertical" initialValues={{ extra: { title: '原说明', capacity: '0.00', approved: '2026-01-01', stage: 'design' } }} onFinish={onFinish}>
      <CustomFieldItems fields={[field('title', '项目说明', 'text'), field('capacity', '库容', 'number'), field('approved', '批复日期', 'date'), field('stage', '阶段', 'select')]} />
      <Button htmlType="submit">提交</Button>
    </Form>,
  );
  fireEvent.change(screen.getByLabelText('项目说明'), { target: { value: '修改说明' } });
  fireEvent.change(screen.getByLabelText('库容'), { target: { value: '1234567890123.123456' } });
  fireEvent.change(screen.getByLabelText('批复日期'), { target: { value: '2026-10-02' } });
  fireEvent.mouseDown(screen.getByLabelText('阶段'));
  fireEvent.click(await screen.findByText('施工'));
  fireEvent.click(screen.getByRole('button', { name: /提\s*交/ }));
  await waitFor(() => expect(onFinish).toHaveBeenCalledWith({ extra: { title: '修改说明', capacity: '1234567890123.123456', approved: '2026-10-02', stage: 'build' } }));
}, 20_000);
