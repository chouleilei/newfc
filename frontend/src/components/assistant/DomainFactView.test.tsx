// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DomainFactView } from './DomainFactView';

beforeAll(() => { Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn((query) => ({ matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })) }); });

describe('跨域精确事实与来源呈现', () => {
  it('大额十进制文本保留每一分，来源定位同一个业务对象，缺源不显示零', () => {
    render(<MemoryRouter><DomainFactView fact={{ type: 'tool:contract_detail', data: { currentAmount: '90071992547409.93', paidAmount: '25000.00', missingSource: null }, source: { references: [{ kind: 'contract', id: 7, label: 'HT-7', path: '/contracts?id=7' }] } }} /></MemoryRouter>);
    expect(screen.getByText('90071992547409.93')).toBeTruthy();
    expect(screen.getByText('当前金额（元）')).toBeTruthy();
    expect(screen.getByText('未提供')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'HT-7 · #7' }).getAttribute('href')).toBe('/contracts?id=7');
  });
});
