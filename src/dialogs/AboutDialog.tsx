/**
 * dialogs/AboutDialog.tsx — 关于本软件（品牌介绍）
 *
 * adj419：脚本兼容说明 / 致谢 / 谱师 / 命令行工作流四段移到「操作手册」（docs/USER-GUIDE.md §九），
 * 关于对话框只留品牌介绍、署名、版本与协议。
 * adj492：内容**迁入底栏 dock**（顶栏菜单「关于」改为开关 dock 的关于页签，与原「试听/导出/设置」
 * 同一套路）——`inline` 模式只交出内容，不带遮罩/标题栏/✕。
 */
import { Modal } from '../ui/Modal'
import { aboutCopy, uiCopy, donate } from '../brand/copy'
import { APP_VERSION_FULL } from '../brand/version'
// adj724b：外链统一走这处（桌面壳需要 Tauri opener，`window.open` 不可靠）
import { openExternalUrl } from '../preview/openUrl'
import { useUiStore } from '../store/uiStore'

export function AboutDialog({ inline = false }: { inline?: boolean } = {}) {
  const openModal = useUiStore((s) => s.openModal)

  return (
    <Modal title={uiCopy.about} inline={inline}>
      {/* adj492：`.about-panel` 的流式布局见 index.css——dock 里是「宽而扁」的一行，
          弹窗里是窄栏竖排；同一份内容两种容器都不别扭 */}
      <div className="about-panel">
        <div className="about-brand">
          <img
            className="about-logo"
            /* adj724b：同上——绝对路径在嵌入版（`/<token>/` 下）会 404，必须走 `BASE_URL` */
            src={`${import.meta.env.BASE_URL}icons/logo-jp.png`}
            alt="爱记谱 iJipu Logo"
            width={inline ? 40 : 64}
            height={inline ? 40 : 64}
          />
          <div className="about-brand-text">
            <div className="about-title">{aboutCopy.title}</div>
            <div className="about-tagline">{aboutCopy.tagline}</div>
          </div>
        </div>
        <div className="about-body">
          {aboutCopy.body.split('\n').map((p, i) => (
            <p key={i} className="about-p">
              {p}
            </p>
          ))}
          {/* adj419：作者署名（+ 可选联系方式，邮箱留空则不显示） */}
          <p className="about-author">
            <strong>{aboutCopy.author}</strong>
            {aboutCopy.contact && <span className="about-contact">{aboutCopy.contact}</span>}
          </p>
          {/**
           * adj724b（用户要求）：官方网址与 Obsidian 插件仓库。
           *
           * 用 `<button>` + `openExternalUrl` 而不是 `<a href target="_blank"`：
           * 桌面壳（Tauri v2 / WebView2）里 `window.open`/`_blank` **不保证**打开系统浏览器
           * （见 `preview/openUrl.ts` 的文件头说明）——那里已经把"Tauri opener → window.open"
           * 的兜底做好了，直接复用同一处，不另写一套。
           */}
          <div className="about-links">
            {aboutCopy.links.map((l) => (
              <button
                key={l.url}
                type="button"
                className="about-link"
                title={`${l.hint}：${l.url}`}
                onClick={() => void openExternalUrl(l.url)}
              >
                <span className="about-link-label">{l.label}</span>
                <span className="about-link-url">{l.url}</span>
              </button>
            ))}
          </div>
          <div className="about-meta">{APP_VERSION_FULL}</div>
          <p className="about-footer">{aboutCopy.footer}</p>
          {/* adj419：脚本兼容说明 / 致谢 / 谱师 / 命令行工作流四段移到「操作手册」（docs/USER-GUIDE.md §九），
              adj422：连「本项目以 AGPL-3.0 协议开源…」这句也一并移过去——关于只留品牌介绍、署名、版本
              与底部的支持入口；协议说明在操作手册与仓库 LICENSE 里 */}
          <div className="about-cta">
            {donate.image ? (
              <button type="button" className="about-donate" onClick={() => openModal('donate')}>
                {donate.label}
              </button>
            ) : (
              <span className="about-license">{aboutCopy.license}</span>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}
