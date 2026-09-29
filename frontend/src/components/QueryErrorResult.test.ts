import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { scopeErrorHint } from './QueryErrorResult';

describe('组织范围错误提示(AC-X04)', () => {
  it('SCOPE_REQUIRED 提示先选组织,SCOPE_RESTRICTED 说明集团口径;其他错误走通用重试', () => {
    expect(scopeErrorHint(new ApiError({ code: 'SCOPE_REQUIRED', message: '当前账号授权了多个组织' }, 400))).toMatchObject({ status: 'info' });
    expect(scopeErrorHint(new ApiError({ code: 'SCOPE_RESTRICTED', message: '只对全组织用户开放' }, 403))).toMatchObject({ status: 403 });
    expect(scopeErrorHint(new ApiError({ code: 'NOT_FOUND', message: '不存在' }, 404))).toBeNull();
    expect(scopeErrorHint(new Error('网络错误'))).toBeNull();
  });
});
