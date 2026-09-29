/** API 客户端:统一错误结构处理 + Cookie 会话与 CSRF 令牌 */

export interface ApiErrorBody {
  code: string;
  message: string;
  errors?: { row: number; field: string; message: string }[];
  /** 部分错误携带结构化恢复信息(如清洗 410 返回可恢复的 plan/target/sha256) */
  details?: unknown;
}

export class ApiError extends Error {
  constructor(public body: ApiErrorBody, public status: number) {
    super(body.message);
  }
}

export interface ErrorTextOptions {
  includeFieldErrors?: boolean;
  fallback?: string;
}

/** 统一错误文本:默认展开 API 字段错误,保留普通 Error 与未知值的原始信息。 */
export function errorText(error: unknown, options: ErrorTextOptions = {}): string {
  const fallback = options.fallback ?? '未知错误';
  if (error instanceof ApiError) {
    const message = error.body.message || fallback;
    if (options.includeFieldErrors !== false) {
      const errors = error.body.errors?.map((item) => `第${item.row}行[${item.field}]: ${item.message}`).join(';');
      return errors ? `${message}:${errors}` : message;
    }
    return message;
  }
  if (error instanceof Error) return error.message;
  if (error == null) return fallback;
  return String(error);
}

/** 会话失效事件:App 监听后切回登录页 */
export const AUTH_EXPIRED_EVENT = 'newfc-auth-expired';
/** 需要先修改口令事件:App 监听后进入改口令页 */
export const PASSWORD_CHANGE_EVENT = 'newfc-password-change-required';

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  permissions: string[];
  allOrgs: boolean;
  orgIds: number[];
  mustChangePassword: boolean;
}

/** /api/auth/session 与 /api/auth/login 的响应;会话令牌只在 HttpOnly Cookie 中,前端拿不到 */
export interface SessionInfo {
  authenticated: true;
  user: SessionUser;
  csrfToken: string;
  expiresAt: string;
}

/* CSRF 令牌只放内存:刷新页面后由 /auth/session 重新取得,不落 localStorage */
let currentSession: SessionInfo | null = null;

export function setSession(session: SessionInfo | null): void {
  currentSession = session;
}
export function getSession(): SessionInfo | null {
  return currentSession;
}
/** 前端按权限隐藏入口只是体验优化,后端仍逐请求校验 */
export function can(permission: string): boolean {
  return currentSession?.user.permissions.includes(permission) ?? false;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** 写请求附带 CSRF 令牌;供 request() 与流式对话等直接 fetch 的路径共用 */
export function csrfHeaders(method: string): Record<string, string> {
  if (SAFE_METHODS.has(method.toUpperCase()) || !currentSession) return {};
  return { 'x-csrf-token': currentSession.csrfToken };
}

export interface RequestOptions { signal?: AbortSignal; csrfRetried?: boolean }

/** 会话失效/需改口令处理:广播给 App(登录接口的 AUTH_FAILED 不在此列) */
export function handleUnauthorized(body: { code?: string } | null | undefined): void {
  if (body?.code === 'UNAUTHORIZED') {
    setSession(null);
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
  } else if (body?.code === 'PASSWORD_CHANGE_REQUIRED') {
    window.dispatchEvent(new CustomEvent(PASSWORD_CHANGE_EVENT));
  }
}

export async function request<T>(method: string, path: string, body?: unknown, extra?: RequestOptions): Promise<T> {
  const headers: Record<string, string> = { ...csrfHeaders(method) };
  if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
    signal: extra?.signal,
  });
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    if (!res.ok) throw new Error(`请求失败: HTTP ${res.status}`);
    return (await res.blob()) as unknown as T;
  }
  const data = await res.json();
  if (!res.ok) {
    // CSRF 令牌过时(例如其他标签页重新登录换了会话):刷新会话取新令牌后重试一次
    if ((data as ApiErrorBody).code === 'CSRF_REJECTED' && !extra?.csrfRetried && !path.startsWith('/auth/session') && await refreshSession()) {
      return request<T>(method, path, body, { ...extra, csrfRetried: true });
    }
    handleUnauthorized(data as ApiErrorBody);
    throw new ApiError(data as ApiErrorBody, res.status);
  }
  return data as T;
}

async function refreshSession(): Promise<boolean> {
  try {
    setSession(await request<SessionInfo>('GET', '/auth/session'));
    return true;
  } catch {
    return false;
  }
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
};

/** download() 的进度与结果反馈事件:由 App 内的全局监听统一弹提示 */
export const DOWNLOAD_FEEDBACK_EVENT = 'budget-download-feedback';
export interface DownloadFeedbackDetail {
  id: number;
  phase: 'start' | 'done' | 'error';
  filename: string;
  message?: string;
}
let downloadSeq = 0;

/**
 * 下载导出文件。
 *
 * 失败不再静默:通过 DOWNLOAD_FEEDBACK_EVENT 广播「开始 / 成功 / 失败」,由 App 里的
 * DownloadFeedback 统一提示;本函数不抛出,而是返回是否成功——历史上大量调用点写作
 * `onClick={() => download(...)}`,一旦抛出就是未捕获 rejection,用户点了按钮毫无反馈。
 */
export async function download(path: string, filename: string): Promise<boolean> {
  const id = ++downloadSeq;
  const emit = (detail: Omit<DownloadFeedbackDetail, 'id' | 'filename'>) =>
    window.dispatchEvent(new CustomEvent<DownloadFeedbackDetail>(DOWNLOAD_FEEDBACK_EVENT, { detail: { id, filename, ...detail } }));
  emit({ phase: 'start' });
  try {
    const blob = await request<Blob>('GET', path);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    emit({ phase: 'done' });
    return true;
  } catch (error) {
    emit({ phase: 'error', message: error instanceof Error ? error.message : '未知错误' });
    return false;
  }
}
