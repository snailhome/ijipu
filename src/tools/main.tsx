/**
 * tools/main.tsx — `/tools/` 独立页入口（adj1316）
 *
 * 刻意**不复用应用（`src/main.tsx`）的任何启动链**：那边要初始化 store、宿主桥、音色库、
 * Service Worker…；这个工具页只要 React + 三个页签，首包越干净越好（它是被"随手打开"的）。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './tools.css'

const host = document.getElementById('tools-root')
if (host !== null) {
  createRoot(host).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
