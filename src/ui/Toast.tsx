/**
 * ui/Toast.tsx — 轻量浮动提示（右上角、顶栏下方）
 *
 * 消费 uiStore.notice（保存成功/失败等），按 notice.nonce 重置自动隐藏计时：
 *  - ok（绿）：约 1.8s 隐藏；warn（黄）约 6s（含操作指引，adj401）；error（红）约 4s。
 * 无提示时不渲染任何元素。
 *
 * adj1013（用户要求）：提示原来贴在**右下角**，而常用操作底栏 dock 也在右下
 * （宽屏左右拆分时 dock 就挂在编辑列底部）⇒ 经常盖住正要点的内容。
 * 现在挪到**右上角、顶栏正下方**；多行文案**向下延伸**（CSS 只给 top、不给高度，见 index.css `.toast`）。
 *
 * adj728（用户要求）：提示可以带**一个动作按钮**（`notice.action`）——
 * 「无法下载音色库的提示显示时间不长，应有个按钮链接用户打开全局的音色库」。
 * **有按钮的提示不自动消失**：它是"要你去别处做一件事"，几秒读完、还要点得到，做不到。
 */
import { useEffect } from 'react'
import { useUiStore } from '../store/uiStore'

export function Toast() {
  const notice = useUiStore((s) => s.notice)
  const clearNotice = useUiStore((s) => s.clearNotice)

  // notice 变化（每次 showNotice 都新建对象）时重置隐藏计时；unmount/清空时清理
  useEffect(() => {
    if (!notice) return
    // adj728：带动作按钮的提示交由用户处置（点按钮 / 下一次提示把它换掉），不自动隐藏
    if (notice.action || (notice.actions?.length ?? 0) > 0) return
    // adj401：warn 提示常含操作指引（如手机端找不到 .jps 时怎么办），4s 读不完 → 给 6s
    const ms = notice.kind === 'ok' ? 1800 : notice.kind === 'warn' ? 6000 : 4000
    const t = setTimeout(clearNotice, ms)
    return () => clearTimeout(t)
  }, [notice, clearNotice])

  if (!notice) return null
  const actions =
    notice.actions !== undefined && notice.actions.length > 0
      ? notice.actions
      : notice.action
        ? [notice.action]
        : []
  return (
    <div className={`toast toast-${notice.kind}${actions.length > 0 ? ' toast-has-action' : ''}`}>
      <span className="toast-text">{notice.text}</span>
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          className="toast-action btn"
          onClick={() => {
            // 先收起提示再执行动作：动作会开对话框，提示留在屏幕上会挡住视线
            clearNotice()
            action.run()
          }}
        >
          {action.label}
        </button>
      ))}
    </div>
  )
}
