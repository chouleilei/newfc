import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, useAntdTheme } from './theme';
import App from './App';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import 'antd/dist/reset.css';
/* 全站图标体系统一为 Remix Icon。 */
import 'remixicon/fonts/remixicon.css';
/**
 * 「年度账册」的字体资产(自托管 latin 子集):
 * - Fraunces 500/600 衬线:只用于 KPI 大数字与页级标题,账册/年报的仪表感签名;
 * - IBM Plex Mono 500:只用于眉题/档签类短装饰位(编号、FY 标签),不进正文表格;
 * 两者都是 latin-only,中文自动落回系统字体,中西混排时「数字有排版感,汉字保持原生」。
 */
import '@fontsource/fraunces/latin-500.css';
import '@fontsource/fraunces/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
/**
 * 正文与数字字体自托管 IBM Plex Sans(方案 3.7)。
 *
 * 原先正文栈首位的 Roboto **未自托管**,依赖系统预装 —— Windows 不预装 Roboto,
 * 于是正文与全部表格金额实际落到微软雅黑,与自托管的 KPI 大数字字体是两套字形。
 * 数字是本系统的内容本体,两套字形并存即「仪器感」不稳的根源。
 *
 * 只引 latin 子集(400/500/600 三档),包体增量百余 KB 级;它不含中文字形,
 * 中文自然落回系统字体(Windows 即雅黑,原生观感),现有栈结构一行未动。
 * 中文保持系统字体 —— 升级点只在数字与拉丁文。
 */
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
});

/** 拆一层以在 ConfigProvider 内读取主题上下文,并挂 antd App(message/modal 上下文) */
function Root() {
  const antdTheme = useAntdTheme();
  return (
    <ConfigProvider locale={zhCN} theme={antdTheme}>
      <AntApp>
        <AppErrorBoundary>
          <QueryClientProvider client={queryClient}>
            <App />
          </QueryClientProvider>
        </AppErrorBoundary>
      </AntApp>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <Root />
    </ThemeProvider>
  </React.StrictMode>
);
