/**
 * store/playbackBridge.ts — 试听会话对外的**控制桥**（adj1301）
 *
 * ## 为什么需要它
 *
 * 用户要求：**浮动栏隐藏时播放不能停**，并在顶栏「试听」按钮下方给一条只有三个按钮的
 * 小工具条（播放·暂停 / 停止 / 设置）。这两条把播放控制拆到了两个互不相邻的组件里：
 *
 * · 真正的播放会话（音源、时钟、色块、高亮）在 `dialogs/PlaybackDialog.tsx` 里，
 *   它挂在右栏面板里；栏一关，React 会卸载它（原来的清理函数 `backend.dispose()` 会**停播**）；
 * · 小工具条在顶栏下方（`ui/PlaybackMiniBar.tsx`），栏关着的时候只有它看得见。
 *
 * 两条同时成立 ⇒ 需要一个**不属于任何组件**的登记处：`PlaybackDialog` 把自己当前的
 * 播放状态与两个动作（`toggle` / `stop`）登记进来；小工具条订阅它、照着渲染。
 *
 * ## 口径
 *
 * · 这个模块**不持有**播放状态（唯一来源仍是 `PlaybackDialog` 的 React state），
 *   它只是一份"最新的控制面"快照——两处不会各自漂移；
 * · 组件卸载时**必须** `setPlaybackBridge(null)`，否则小工具条会对着一个已死的会话发命令；
 * · 快照对象每次登记都换成新引用（`useSyncExternalStore` 靠引用变化重渲染）。
 */

/** 小工具条需要知道/能做的全部事情 */
export interface PlaybackBridgeState {
  /** 会话仍在进行（**含暂停**）：暂停时也应显示工具条，因为还能"继续" */
  playing: boolean
  /** 已暂停（与 `playing === true` 同时成立才表示"暂停中"） */
  paused: boolean
  /** 音源/序列准备中（按钮禁用） */
  starting: boolean
  /** 播放键的开关语义：未播放 → 播；播放中 → 暂停；暂停中 → 继续 */
  toggle: () => void
  /** 停止并收尾（色块/高亮清空） */
  stop: () => void
}

let current: PlaybackBridgeState | null = null
const listeners = new Set<() => void>()

/** 登记（或清空）当前控制面；组件每次状态变化都要调一次 */
export function setPlaybackBridge(next: PlaybackBridgeState | null): void {
  current = next
  for (const fn of listeners) fn()
}

/** 读当前控制面（`useSyncExternalStore` 的 getSnapshot；无面板挂载时为 null） */
export function getPlaybackBridge(): PlaybackBridgeState | null {
  return current
}

/** 订阅控制面变化；返回取消订阅 */
export function subscribePlaybackBridge(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
