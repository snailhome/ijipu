/**
 * dialogs/PasteImportDialog.tsx — 「粘贴源码导入」（adj406）
 *
 * 为什么要有这个入口：手机端打开 .jps 依赖系统文件选择器，而各家文件管理器/网盘
 * 对自定义扩展名态度不一致——有的按 MIME 隐藏 .jps，有的只能看到本机已下载的文件；
 * 已安装的 PWA 外壳还可能让选择器静默失败。粘贴是最可靠的兜底：微信/网盘里复制的文本、
 * 笔记里的 ```jps 代码块都能直接用。
 *
 * 只做"读入文本并替换当前文档"，**不写磁盘**（保存仍走「文件 → 导出」，文案里已说明）。
 *
 * adj562（用户要求"把粘贴源码导入对话框也加到底栏，就在工作区后面加一个「导入」页签"）：
 * 本组件新增 `inline` 模式（与 adj492 的「关于」同一套路）——dock 里只交出内容
 * （不带遮罩/标题栏/✕），并且**输入框吃掉剩余高度**：dock 拉高时粘贴框跟着变高，
 * 长源码不用在小框里来回滚。弹窗模式（`inline=false`）行为与外观完全不变。
 */
import { useRef, useState } from 'react'
import { Modal } from '../ui/Modal'
import { HelpBadge } from '../ui/HelpBadge'
import { useDocStore } from '../store/docStore'
import { useUiStore } from '../store/uiStore'
import { pasteImportCopy, scorePackageImportCopy } from '../brand/copy'
import {
  createSubdir,
  getWorkspace,
  hasEntry,
  writeWorkspaceBytes,
  writeWorkspaceText,
} from '../store/workspace'
import { readScorePackage, safePackageDirName, suggestNewDirName } from '../store/scorePackageImport'

const TEXT_PACKAGE_EXT = new Set(['json', 'md', 'jps', 'txt'])
const decoder = new TextDecoder('utf-8')

export function PasteImportDialog({ inline = false }: { inline?: boolean } = {}) {
  const [text, setText] = useState('')
  const [packageBusy, setPackageBusy] = useState(false)
  const packageInputRef = useRef<HTMLInputElement | null>(null)
  const importSource = useDocStore((s) => s.importSource)
  const openWorkspaceFile = useDocStore((s) => s.openWorkspaceFile)
  const closeModal = useUiStore((s) => s.closeModal)
  const closeDock = useUiStore((s) => s.closeDock)
  const showNotice = useUiStore((s) => s.showNotice)

  /**
   * adj562：两种容器的"收场"不同——弹窗用 `closeModal()`（卸掉遮罩），
   * dock 里用 `closeDock()`（收起底栏）。导入成功后都回到编辑区，用户马上能看到新谱。
   */
  const dismiss = () => {
    if (inline) closeDock()
    else closeModal()
  }

  /** 从剪贴板读文本（需安全上下文 + 用户手势；失败给可操作提示，不静默） */
  const fromClipboard = async () => {
    try {
      const clip = await navigator.clipboard.readText()
      if (!clip.trim()) {
        showNotice(pasteImportCopy.clipboardEmpty, 'warn')
        return
      }
      setText(clip)
    } catch {
      showNotice(pasteImportCopy.clipboardFailed, 'warn')
    }
  }

  const doImport = () => {
    if (!importSource(text)) {
      showNotice(pasteImportCopy.empty, 'warn')
      return
    }
    showNotice(pasteImportCopy.ok(text.replace(/\s/g, '').length), 'ok')
    dismiss()
  }

  const pickPackage = async (file: File | undefined): Promise<void> => {
    if (!file) return
    setPackageBusy(true)
    try {
      const ws = await getWorkspace()
      if (!ws) {
        showNotice(scorePackageImportCopy.needWorkspace, 'warn')
        return
      }
      let pkg: ReturnType<typeof readScorePackage>
      try {
        pkg = readScorePackage(new Uint8Array(await file.arrayBuffer()))
      } catch (e) {
        const msg = e instanceof Error && e.message === 'bad-path'
          ? scorePackageImportCopy.badPath
          : scorePackageImportCopy.badZip
        showNotice(msg, 'error')
        return
      }

      const base = safePackageDirName(pkg.title)
      let dirName = base
      const exists = await hasEntry(ws, ws.path, dirName)
      if (exists) {
        const overwrite = window.confirm(scorePackageImportCopy.conflict(dirName))
        if (!overwrite) {
          let attempt = 2
          for (;;) {
            const input = window.prompt(scorePackageImportCopy.newDirTitle, suggestNewDirName(base, attempt))
            attempt += 1
            if (input === null) return
            const name = input.trim()
            if (name === '' || /[\\/:*?"<>|]/.test(name)) {
              showNotice(scorePackageImportCopy.invalidDir, 'warn')
              continue
            }
            if (await hasEntry(ws, ws.path, name)) {
              showNotice(scorePackageImportCopy.newDirHint(name), 'warn')
              continue
            }
            dirName = name
            break
          }
          await createSubdir(ws, ws.path, dirName)
        }
      } else {
        await createSubdir(ws, ws.path, dirName)
      }

      showNotice(scorePackageImportCopy.creating, 'ok')
      for (const f of pkg.files) {
        const segs = [...ws.path, dirName, ...f.path.split('/')]
        const ext = f.path.split('.').pop()?.toLowerCase() ?? ''
        if (TEXT_PACKAGE_EXT.has(ext)) {
          await writeWorkspaceText(ws, segs, decoder.decode(f.bytes))
        } else {
          await writeWorkspaceBytes(ws, segs, f.bytes)
        }
      }
      const opened = await openWorkspaceFile([...ws.path, dirName, 'score.jps'])
      showNotice(scorePackageImportCopy.done(dirName), 'ok')
      if (!opened) showNotice(scorePackageImportCopy.openFailed, 'warn')
      dismiss()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      showNotice(
        msg.includes('二进制') ? scorePackageImportCopy.unsupportedBinary : scorePackageImportCopy.failed(msg),
        'error',
      )
    } finally {
      setPackageBusy(false)
      if (packageInputRef.current) packageInputRef.current.value = ''
    }
  }

  return (
    <Modal title={pasteImportCopy.title} width={560} inline={inline}>
      {/* adj562：dock 里套 `.import-body`（flex 列 + 吃满高度，见 index.css 的 `.pane-import`）；
          弹窗里保持原来的内联样式（一次性 200px 高的粘贴框，可纵向拖拽改高）。 */}
      <div
        className={inline ? 'import-body' : undefined}
        style={inline ? undefined : { display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        {/* adj579（用户要求）：编辑器上方改成**标签 + `?` 小图标**——原来那条两行说明（`desc`）
            收进 `?` 的提示，把高度让给粘贴框（与 adj578 工作区选择界面同一套路）。
            adj581（用户要求）：文案去掉冒号，且标题统一成**谱面页的行标题样式**
            （`.pcfg-group-title`，即设置→谱面里「纸张与边距」那种）——`?` 放在标题元素内部，
            于是图标紧跟文字、而下边框与左侧强调竖条横贯整行。
            adj585（用户要求）：`?` **点一下就地展开**说明（PC 仍是悬浮 title）——触屏上没有 hover，
            旧版只能让这条说明常驻，白占两行高度。 */}
        <div className="pcfg-group-title import-label">
          <span>{pasteImportCopy.label}</span>
          <HelpBadge hint={pasteImportCopy.desc} />
        </div>
        <textarea
          className={inline ? 'import-text' : undefined}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={pasteImportCopy.placeholder}
          spellCheck={false}
          style={{
            // dock 模式由 `.import-text` 接管高度（flex:1 + min-height），弹窗模式保持 200px
            ...(inline ? null : { minHeight: 200 }),
            fontFamily: 'var(--jp-font-mono)',
            fontSize: 13,
            lineHeight: 1.6,
            padding: '8px 10px',
            borderRadius: 6,
            color: 'var(--jp-text-primary)',
            background: 'var(--jp-bg-app)',
            border: '1px solid var(--jp-border)',
            resize: (inline ? 'none' : 'vertical') as 'none' | 'vertical',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <button type="button" className="btn" onClick={() => void fromClipboard()}>
            {pasteImportCopy.fromClipboard}
          </button>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={dismiss}>
              {pasteImportCopy.cancelBtn}
            </button>
            <button type="button" className="btn primary" onClick={doImport}>
              {pasteImportCopy.importBtn}
            </button>
            <button
              type="button"
              className="btn"
              disabled={packageBusy}
              onClick={() => packageInputRef.current?.click()}
            >
              {packageBusy ? '正在导入…' : scorePackageImportCopy.button}
            </button>
            <input
              ref={packageInputRef}
              type="file"
              accept=".zip,application/zip"
              hidden
              onChange={(e) => void pickPackage(e.target.files?.[0])}
            />
          </div>
        </div>
      </div>
    </Modal>
  )
}
