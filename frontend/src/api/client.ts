/** API 客户端:统一错误结构处理 + 登录会话令牌(x-access-token) */

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

const TOKEN_KEY = 'budget-access-token';
/** 会话令牌过期事件:App 监听后切回登录页 */
export const AUTH_EXPIRED_EVENT = 'budget-auth-expired';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export interface SessionInfo {
  authEnabled: boolean;
  username: string | null;
}

export interface RequestOptions { signal?: AbortSignal }

/** 会话失效处理:清令牌并广播,由 App 切回登录页(登录接口的 AUTH_FAILED 不在此列) */
export function handleUnauthorized(body: { code?: string } | null | undefined): void {
  if (body?.code === 'UNAUTHORIZED') {
    clearToken();
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
  }
}

export async function request<T>(method: string, path: string, body?: unknown, extra?: RequestOptions): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['x-access-token'] = token;
  if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';
  const res = await fetch(`/api${path}`, {
    method,
    headers,
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
    handleUnauthorized(data as ApiErrorBody);
    throw new ApiError(data as ApiErrorBody, res.status);
  }
  return data as T;
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
