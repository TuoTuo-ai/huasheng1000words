import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./styles/index.css";
import App from "./App";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ensurePersistentStorage } from "@/lib/storagePersist";

// 启动阶段安全申请持久化存储：不等待、不阻塞渲染，任何失败都不影响 App 启动
void ensurePersistentStorage().catch(() => undefined);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* 最外层错误边界：连路由 / 布局本身出错时也能兜住 */}
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
