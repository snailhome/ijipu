/**
 * tools/App.tsx — `/tools/` 的壳：顶栏 + 三个页签（adj1316）
 *
 * 三个页签互相独立（各自管文件与状态），切页签**不卸载**已载入的文件：
 * 比如先拆出一个音频再看片段截取，来回切不该丢东西。
 */
import { useState } from 'react'
import { toolsCopy } from './copy'
import { MergePanel } from './MergePanel'
import { SplitPanel } from './SplitPanel'
import { ClipPanel } from './ClipPanel'

type TabKey = 'merge' | 'split' | 'clip'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'merge', label: toolsCopy.tabs.merge },
  { key: 'split', label: toolsCopy.tabs.split },
  { key: 'clip', label: toolsCopy.tabs.clip },
]

export function App() {
  const [tab, setTab] = useState<TabKey>('merge')
  return (
    <div className="t-shell">
      <header className="t-top">
        <a className="t-brand" href="/">
          <img src="/icons/Jianpu.png" alt="" width={28} height={28} />
          <span className="t-brand-name">{toolsCopy.brand}</span>
          <span className="t-brand-sub">{toolsCopy.brandSub}</span>
        </a>
        <nav className="t-nav">
          <span className="t-badge">{toolsCopy.localBadge}</span>
          <a href="/">{toolsCopy.backHome}</a>
          <a href="/app/">{toolsCopy.openApp}</a>
          <a href="/manual/">{toolsCopy.docs}</a>
        </nav>
      </header>
      <p className="t-intro">{toolsCopy.intro}</p>
      <div className="t-tabs" role="tablist" aria-label={toolsCopy.brand}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={tab === t.key ? 't-tab is-active' : 't-tab'}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {/* 三个面板都用 CSS 藏起来而不卸载：载入的音频/视频与选区不该因为切页签丢掉 */}
      <div className="t-panels">
        <div className="t-panel" hidden={tab !== 'merge'}>
          <MergePanel />
        </div>
        <div className="t-panel" hidden={tab !== 'split'}>
          <SplitPanel />
        </div>
        <div className="t-panel" hidden={tab !== 'clip'}>
          <ClipPanel />
        </div>
      </div>
    </div>
  )
}
