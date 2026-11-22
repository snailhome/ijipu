/**
 * dialogs/ShortcutsDialog.tsx — 快捷键速查
 *
 * adj419：① 行首命令按**小写**书写（编辑器实际按小写字母触发，大小写都认；
 *          原速查写成大写容易让人以为要按 Shift）；② 补上描述头 `y`（默认乐器）、
 *          `s`（说明文字）与 `v`（版本）；③ 去掉解析器并不认识的 `h`。
 */
import { Modal } from '../ui/Modal'
// adj617（用户要求）：键名只在 `brand/shortcuts.ts` 定义一次——速查表也引它（不写字面量）
import { KBD, newDocKbd } from '../brand/shortcuts'

const SHORTCUTS: [string, string][] = [
  // adj628：键名来自 `brand/shortcuts.ts`（**按平台给**：桌面 = Ctrl+N；网页版 = Alt+N，
  // 因为浏览器把 Ctrl+N 占作"开新窗口"、页面收不到）——这里不写字面量，平台差异见表下的说明行。
  // adj954：改用 `newDocKbd()` 现算（原先读 `KBD.newDoc`，那个值在模块加载时就定死了）
  [newDocKbd(), '新建'],
  // adj619b（用户要求）：`Ctrl+O` 回到「打开文件」；导出改用 `Ctrl+Y`
  [KBD.openDoc, '打开文件'],
  [KBD.export, '导出（底栏）'],
  [KBD.print, '打印（浏览器里被内核占用，见下）'],
  [KBD.save, '保存'],
  ['Ctrl+Z', '撤销'],
  // adj619b：`Ctrl+Y` 让给「导出」后，重做改用跨平台惯例 `Ctrl+Shift+Z`
  [KBD.redo, '重做'],
  [KBD.tryout, '试听播放'],
  // adj1321（用户要求）：焦点不在编辑区 / 右栏底栏 / 输入框时，空格 = 播放/暂停
  [KBD.spacePlay, '试听播放/暂停（焦点不在编辑区、右栏底栏或输入框时）'],
  // adj723（用户要求）：Ctrl+点音符 = 立即打开试听并从此处播放（与单击/双击的差别见 KBD 注释）
  // adj965（用户指正）：这里是**纯文本**表格 ⇒ 不许写 `**加粗**`（会显示成字面星号）
  [KBD.tryoutFromNote, '预览区点音符：立即试听并从该音符播放'],
  ['Tab', '编码 / 预览 切换'],
  ['1 / 2 / 3', '视图：编码 / 拆分 / 预览'],
  ['q / c', '行首插入曲行 Q: / 词行 C:'],
  ['b / z', '行首插入标题 B: / 作者 Z:'],
  ['d / p / j', '行首插入调式 D: / 拍号 P: / 节拍 J:'],
  ['y / s', '行首插入默认乐器 Y: / 说明文字 S:'],
  ['v', '行首插入版本 V:'],
  // adj608/adj612/adj613（用户要求）：ESC = 最小化底栏（底栏开着就生效；更内层的输入/菜单/对话框优先，
  // 焦点在底栏的输入框里时：第一次退出输入框、第二次才最小化）
  [KBD.dockMin, '最小化底栏（输入框里先退出输入）'],
  // adj610（用户要求）：底栏展开/收起 + 高度档位各配一个快捷键
  [KBD.dock, '展开 / 收起底栏'],
  [KBD.dockSize, '底栏高度档位（建议 → 最大 → 建议 → 最小）'],
  // adj614（用户要求）：折行 / 输入条 / 深浅模式 / 视图 各配一个快捷键
  // （注：`Ctrl+T` 在**浏览器**里被内核占用（新标签页）、拦不住 ⇒ 网页版请点顶栏按钮；
  //   桌面端实测四条都可用，见 E-2026-300）
  [KBD.wrap, '折行开关'],
  [KBD.pad, '输入条开关'],
  [KBD.theme, '深浅模式（随系统 → 浅色 → 深色）'],
  [KBD.view, '视图循环（编码 → 拆分 → 左右拆分 → 预览）'],
  // adj616（用户要求）：排版 / 工作区 / 导入 三个开关
  [KBD.guides, '排版辅助虚线开关'],
  [KBD.workspace, '工作区开关'],
  [KBD.import, '导入开关'],
  // adj641（用户要求）：查找替换（底栏页签；接管浏览器原生 Ctrl+F，连按只重新聚焦查找框）
  [KBD.find, '查找替换（底栏页签；Enter 下一个 / Shift+Enter 上一个）'],
  // adj618（用户要求）：告警开关（按 Shift 的 `Ctrl+~` 同款同效，不留死键）
  // adj1290：告警已从底栏页签独立成抽屉（贯穿底部、默认收起）
  [KBD.problems, '告警抽屉开关'],
  // adj619c（用户要求）：速查改成 `Alt+F1`
  [KBD.shortcuts, '本快捷键速查'],
]

export function ShortcutsDialog() {
  return (
    <Modal title="快捷键速查">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
        {SHORTCUTS.map(([k, desc]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
            <span
              style={{
                fontFamily: 'var(--jp-font-mono)',
                color: 'var(--jp-accent)',
                background: 'var(--jp-bg-app)',
                padding: '2px 8px',
                borderRadius: 5,
                fontSize: 12,
              }}
            >
              {k}
            </span>
            <span style={{ color: 'var(--jp-text-secondary)' }}>{desc}</span>
          </div>
        ))}
        {/* adj419：说明行首命令的触发条件与大小写（避免"按了没反应"的困惑） */}
        <div style={{ color: 'var(--jp-text-muted)', fontSize: 12, marginTop: 4 }}>
          行首命令：光标在**行首**（行首或换行后）按上述字母即插入命令头，字母大小写均可；
          插入的永远是标准大写命令头（如按 q 得到 `Q: `）。
        </div>
        {/* adj628：平台差异统一说明（左列显示的**就是当前平台可用的键**，不写字面量免得与 KBD 表漂移）：
            浏览器会把"开新窗口 / 新标签页 / 打印"这类组合留给自己，页面收不到 ⇒ 网页版那几条改用别的键或走菜单/按钮。 */}
        <div style={{ color: 'var(--jp-text-muted)', fontSize: 12, marginTop: 4 }}>
          左列是**当前平台**实际可用的键：浏览器会把"开新窗口 / 新标签页 / 打印"这类组合留给自己（页面收不到），
          因此网页版个别条目换成了别的键（如「新建」），或请改点菜单 / 顶栏按钮；桌面端不受此限。
        </div>
      </div>
    </Modal>
  )
}
