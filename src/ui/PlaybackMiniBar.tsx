/**
 * ui/PlaybackMiniBar.tsx — 顶栏试听按钮下方的**小悬浮工具条**（adj1301 / adj1320）
 *
 * ## 用户要求（2026-11-16 初版，2026-11-22 改口径）
 *
 * 初版：「试听播放时，浮动栏隐藏时，播放不停止，并在顶栏试听按钮下添加一个只有三个按钮的小悬浮工具条：
 *  播放·暂停、停止、设置」。
 *
 * adj1320（用户要求）：**顶栏「试听」按钮改为这条小工具条的开关键**——
 *  · 以前点它 = 打开试听页签；现在点它 = 只开关这条小条，不打开页签；
 *  · 只有小工具条上的「设置」才打开试听页签；
 *  · 双击 / `Ctrl+单击` 音符 = 打开这条小条并播放（不再弹页签）；
 *  · 试听页签只要**收起**（不管怎么打开的），这条小条就接着显示。
 *
 * ## 三条边界
 *
 * 1. **两种壳都能用**：右栏壳由 `RightDock`、底栏壳由 `ToolDock` 在 `miniBarOpen` 时把面板树
 *    挂成隐藏态（"关而不卸"），播放会话因此有地方挂；底栏关闭时不再退回"打开试听页签"。
 *    `miniBarOpen` 由顶栏按钮 / 双击音符置位，**打开试听页签也会置位**（收起后接着显示）。
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
  const open = useUiStore((s) => s.dockOpen)
  const miniBarOpen = useUiStore((s) => s.miniBarOpen)
  const setDockPanel = useUiStore((s) => s.setDockPanel)
  const bridge = useSyncExternalStore(subscribePlaybackBridge, getPlaybackBridge, getPlaybackBridge)
  const [pos, setPos] = useState<MiniBarPos | null>(null)

  /**
   * adj1320/adj1321（用户口径）：**顶栏「试听」按钮就是这条小工具条的开关**。
   *
   * 显示条件只剩三条：
   *  · 操作栏收起着（页签开着时面板里本来就有播放/停止/设置，不必再叠一条）；
   *  · 开关是开的（`miniBarOpen`；打开过试听页签也会把它置开）；
   *  · 播放会话已挂载（`bridge` 存在；右栏/底栏在开关开着时都会挂隐藏宿主）。
   *
   * 不再按"当前页签是不是试听 / 有没有在播"判——那是旧按钮语义。
   */
  const visible = !open && miniBarOpen && bridge !== null

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
        title={withKbd(playLabel, KBD.spacePlay)}
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
