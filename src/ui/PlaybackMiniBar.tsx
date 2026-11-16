/**
 * ui/PlaybackMiniBar.tsx — 顶栏试听按钮下方的**小悬浮工具条**（adj1301）
 *
 * ## 用户要求（2026-11-16）
 *
 * 「试听播放时，浮动栏隐藏时，播放不停止，并在顶栏试听按钮下添加一个只有三个按钮的小悬浮工具条：
 *  插入/暂停、停止、设置」（原文"插入"按"播放"理解；实际呈现为 **播放·暂停**）。
 *
 * ## 三条边界
 *
 * 1. **只在"浮动右栏 + 已收起 + 会话进行中"时出现**：底栏模式、插入模式、栏还开着都不显示
 *    （栏开着时试听面板自己就有这三个按钮）。
 * 2. **不持有播放状态**：状态与动作都来自 `store/playbackBridge`（由 `dialogs/PlaybackDialog.tsx`
 *    登记），所以这里不会与面板里的按钮各自漂移。
 * 3. **位置跟着顶栏的「试听」按钮**：按钮可见就居中在它下方；窄屏被折进「更多」时退化为
 *    贴顶栏右下角下方（那一档没有可锚的按钮，但工具条仍然要能点）。
 */
import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { useUiStore } from '../store/uiStore'
import { getPlaybackBridge, subscribePlaybackBridge } from '../store/playbackBridge'
import { playbackMiniCopy } from '../brand/copy'
import { KBD, withKbd } from '../brand/shortcuts'
import { ToolIcon } from './ToolIcon'

/** 工具条与顶栏之间的间隙（px） */
const BAR_GAP = 6

interface MiniBarPos {
  top: number
  left: number
  /** `center` = 锚在试听按钮正中；`right` = 贴顶栏右缘（按钮被折叠时的退化位） */
  anchor: 'center' | 'right'
}

export function PlaybackMiniBar() {
  const side = useUiStore((s) => s.dockSide)
  const float = useUiStore((s) => s.dockFloat)
  const open = useUiStore((s) => s.dockOpen)
  const setDockPanel = useUiStore((s) => s.setDockPanel)
  const bridge = useSyncExternalStore(subscribePlaybackBridge, getPlaybackBridge, getPlaybackBridge)
  const [pos, setPos] = useState<MiniBarPos | null>(null)

  const visible = side === 'right' && float && !open && bridge !== null && (bridge.playing || bridge.starting)

  useLayoutEffect(() => {
    if (!visible) {
      setPos(null)
      return
    }
    const place = (): void => {
      const topbar = document.querySelector<HTMLElement>('.topbar')
      if (!topbar) return
      const tr = topbar.getBoundingClientRect()
      // ⚠ 只在**真实工具条**里找，而且必须是**按钮本身**：
      //  · 顶栏还有一份隐形测量副本（`.topbar-measure`），它也有 `data-tool-key`；
      //  · 真实按钮外面还包了一层 `<span data-tool-key style="display:contents">`（同样是 0 尺寸）。
      // 拿错一个，工具条就会落到"贴右缘"的退化位（`adj1301` 的 verify 就是这么抓到的）。
      const btn = document.querySelector<HTMLElement>(
        '.topbar-toolbar button[data-tool-key="playback"]',
      )
      const br = btn?.getBoundingClientRect()
      if (btn !== null && btn !== undefined && btn.offsetParent !== null && (br?.width ?? 0) > 0) {
        // 按钮在顶栏里还有下内边距 ⇒ "按钮下方 + 6" 可能仍落在顶栏内部；
        // 取两者较大值，保证工具条整体**在顶栏之下**（视觉上不贴住顶栏下边框）。
        setPos({
          top: Math.max(Math.round((br?.bottom ?? tr.bottom) + BAR_GAP), Math.round(tr.bottom + BAR_GAP)),
          left: Math.round((br?.left ?? 0) + (br?.width ?? 0) / 2),
          anchor: 'center',
        })
        return
      }
      // 窄屏：试听按钮被折进「更多」⇒ 贴顶栏右下角下方
      setPos({ top: Math.round(tr.bottom + BAR_GAP), left: Math.round(tr.right - 12), anchor: 'right' })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [visible])

  if (!visible || bridge === null || pos === null) return null

  const playLabel = bridge.starting
    ? playbackMiniCopy.starting
    : bridge.paused
      ? playbackMiniCopy.resume
      : bridge.playing
        ? playbackMiniCopy.pause
        : playbackMiniCopy.play

  return (
    <div
      className="playback-mini"
      role="toolbar"
      aria-label={playbackMiniCopy.wrapLabel}
      style={{
        top: pos.top,
        left: pos.left,
        transform: pos.anchor === 'center' ? 'translateX(-50%)' : 'translateX(-100%)',
      }}
    >
      <button
        type="button"
        className="playback-mini-btn"
        disabled={bridge.starting}
        title={withKbd(playLabel, KBD.tryout)}
        aria-label={playLabel}
        onClick={bridge.toggle}
      >
        <ToolIcon name={bridge.playing && !bridge.paused ? 'pause' : 'play'} size={14} />
      </button>
      <button
        type="button"
        className="playback-mini-btn"
        disabled={!bridge.playing}
        title={playbackMiniCopy.stop}
        aria-label={playbackMiniCopy.stop}
        onClick={bridge.stop}
      >
        <ToolIcon name="stop" size={14} />
      </button>
      <button
        type="button"
        className="playback-mini-btn"
        title={playbackMiniCopy.settings}
        aria-label={playbackMiniCopy.settings}
        onClick={() => setDockPanel('tryout')}
      >
        <ToolIcon name="settings" size={14} />
      </button>
    </div>
  )
}
