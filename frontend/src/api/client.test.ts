import { describe, expect, it } from 'vitest';
import { ApiError, errorText } from './client';

const apiError = (message: string, errors?: { row: number; field: string; message: string }[]) =>
  new ApiError({ code: 'VALIDATION_FAILED', message, errors }, 400);

describe('errorText', () => {
  it('默认展开 ApiError 的逐行字段错误(Tree 页面语义)', () => {
    const error = apiError('校验失败', [
      { row: 2, field: 'amount', message: '金额格式不正确' },
      { row: 3, field: 'org', message: '组织不存在' },
    ]);
    expect(errorText(error)).toBe('校验失败:第2行[amount]: 金额格式不正确;第3行[org]: 组织不存在');
  });

  it('includeFieldErrors:false 只显示主消息(清洗向导语义)', () => {
    const error = apiError('校验失败', [{ row: 2, field: 'amount', message: '金额格式不正确' }]);
    expect(errorText(error, { includeFieldErrors: false })).toBe('校验失败');
  });

  it('ApiError 无字段错误时显示主消息', () => {
    expect(errorText(apiError('版本已锁定'))).toBe('版本已锁定');
  });

  it('ApiError 主消息为空时回退 fallback', () => {
    expect(errorText(apiError(''), { fallback: '操作失败' })).toBe('操作失败');
    expect(errorText(apiError(''))).toBe('未知错误');
  });

  it('普通 Error 显示 message,未知值按字符串处理', () => {
    expect(errorText(new Error('网络中断'))).toBe('网络中断');
    expect(errorText('字符串错误')).toBe('字符串错误');
  });

  it('null/undefined 回退 fallback', () => {
    expect(errorText(null)).toBe('未知错误');
    expect(errorText(undefined, { fallback: '操作失败' })).toBe('操作失败');
  });
});
