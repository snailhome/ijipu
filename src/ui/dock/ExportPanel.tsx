/**
 * ui/dock/ExportPanel.tsx — 底部 dock 的「导出」面板（adj462）
 *
 * ## 为什么不是复用 ExportDialog
 * 原对话框是**为固定宽度弹窗**写的：一列全宽按钮**竖向堆叠**，在底栏里会把 dock 顶得老高。
 * 底栏要的是**流式内容**——随 dock 宽度自动重排、把高度压到最小。所以这里重写布局：
 *  · 动作按钮走 `.dock-actions`（`auto-fit` 等宽网格）→ **dock 越宽，一行装下的格式越多**，
 *    dock 宽度够时 8 个格式 + 源文件挤在 1~2 行，高度从"8 行"降到"1~2 行"；
 *  · 清晰度等选项走 `.dock-field`（标签+控件成组），随宽度自动换行；
 *  · 窄屏（<420px）自动退回「标签在上、控件在下」的一列。
 *
 * ## 行为与原来一致
 * 七个导出目标（SVG/PNG/JPG/PDF/MIDI/WAV/MP3）+ .jps 源文件、图片清晰度 2x/4x/6x、
 * 语法错误拦截、忙态禁用、错误提示——都与原 ExportDialog 相同（逻辑原样搬来）。
 * 导出进行中把任务名写进 `uiStore.exportJob`：**切走/关掉 dock，状态栏仍有动态指示**。
 */
import { useMemo, useRef, useState } from 'react'
import { useDocStore } from '../../store/docStore'
// adj965（方案 OVL，EP-10）：水印/背景资源（与预览/打印共用同一份）
import { withOverlay } from '../../store/overlayAssets'
import { useUiStore, enabledVoicesOf } from '../../store/uiStore'
import { exportCopy, linearSyncCopy, scorePackageCopy } from '../../brand/copy'
import { layoutScore, renderScoreToSvg, buildPlaySequence, inferBpm, eventsToMidi, rangeBox, applyRangeToSvg, readViewBoxOf } from '@ijipu/engine'
import type { ExportRange } from '@ijipu/engine'
import { renderToAudioBuffer, audioBufferToWav, audioBufferToMp3 } from '../../export/audio'
import { exportSvg, exportPng, exportJpg, exportPdf } from '../../export/export'
// adj1002：导出底色（纯函数，带 smoke 断言）
import { exportBgColor } from '../../export/bgChoice'
// adj1078：动态谱视频整块只在桌面壳显示（网站/插件连相机位预览也不并入）
import { canUseDynamicVideo } from '../../export/video/capability'
// adj873（T-3）：导出范围要"预览区实测墨迹盒" ⇒ 从这里量（只量，几何仍在引擎）
import { measureInkFromPreview } from '../../export/exportRange'
import { createHqCache, resolveHqBank } from '../../playback/spessaCache'
import { resolveActiveLibrary, firstEnabledInstrumentRef } from '../../playback/spessaSynthBackend'
// adj729：嵌入版里音源优先取**插件目录**那份（宿主给的 URL；随文库一起走）
import { hostBankUrl } from '../../store/hostBridge'
// adj647：宿主字体实测（导出与预览共用同一份；见 preview/fontMeta.ts）
import { measureFontMeta } from '../../preview/fontMeta'

type ExportKey = 'svg' | 'png' | 'jpg' | 'pdf' | 'pdfImg' | 'midi' | 'wav' | 'mp3' | 'jps'

/** 下载字节（Blob + 临时 <a>） */
function downloadBytes(bytes: Uint8Array, name: string, type: string) {
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/** 导出任务名（状态栏动态指示显示用） */
const JOB_LABEL: Record<ExportKey, string> = {
  svg: 'SVG 矢量图',
  png: 'PNG 图片',
  jpg: 'JPG 图片',
  pdf: 'PDF（打印为 PDF）',
  pdfImg: 'PDF 图片（位图）',
  midi: 'MIDI 音频',
  wav: 'WAV 音频',
  mp3: 'MP3 音频',
  jps: 'iJipu 源文件',
}

export function ExportPanel() {
  const code = useDocStore((s) => s.code)
  const fileName = useDocStore((s) => s.fileName)
  const parseResult = useDocStore((s) => s.parseResult)
  const pageConfig = useDocStore((s) => s.pageConfig)
  // adj354：@@ 恢复默认音色——无 Y 时用试听音色列表第一个启用音色（MIDI/音频导出与试听一致）
  const playbackHqEnabled = useUiStore(enabledVoicesOf)
  // adj1011：导出音频/每次渲染都用**当前选中的音色库**（与试听同一个判据）
  const playbackHqLibrary = useUiStore((s) => s.playbackHqLibrary)
  // adj1002：导出背景（底色 / 是否带背景图，两项独立，L1）；纸色档位来自 previewSoften
  const exportBg = useUiStore((s) => s.exportBg)
  const exportBgImage = useUiStore((s) => s.exportBgImage)
  const setExportBg = useUiStore((s) => s.setExportBg)
  const setExportBgImage = useUiStore((s) => s.setExportBgImage)
  // adj1065：动态谱视频入口 = 预览区相机位（不再开弹窗）；整曲入口清掉标记段范围
  const openDynamicCamera = useUiStore((s) => s.openDynamicCamera)
  const dynamicVideoEnabled = canUseDynamicVideo()
  const previewSoften = useUiStore((s) => s.previewSoften)
  const setExportJob = useUiStore((s) => s.setExportJob)
  // adj1195：导出乐谱包（zip）走独立对话框；三端轻功能
  const openModal = useUiStore((s) => s.openModal)  // adj626：PDF 走打印（与 Ctrl+P / 菜单「打印」同一条路：同一份页面 + 同一个默认文件名）
  const printScore = useDocStore((s) => s.printScore)
  const defaultInstrumentRef = useMemo(() => firstEnabledInstrumentRef(playbackHqEnabled), [playbackHqEnabled])

  const [busy, setBusy] = useState<ExportKey | null>(null)
  const [error, setError] = useState<string | null>(null)
  // adj294：图片清晰度（PNG/JPG 共用倍率，2x 标准 / 4x 高清 / 6x 超清）；adj412：PDF 同档
  const [imgScale, setImgScale] = useState<number>(2)
  /**
   * adj873（T-3）：「导出范围」。**默认 `page`**（整页 + 留白）—— 与改动前逐字一致 ✓，
   * 不静默改成"谱面" ✗。选「谱面」时几何**只走引擎**（`rangeBox` + `applyRangeToSvg`）。
   */
  const [exportRange, setExportRange] = useState<ExportRange>('page')
  const hqCacheRef = useRef(createHqCache())

  // adj352：导出基名剥掉残留的 .jps/.md/.txt（手机端常把 .jps 识别为 .md/.txt → xxx.md.jpg）
  const baseName = (fileName || '未命名').replace(/\.(jps|md|txt)$/i, '')
  const hasError = parseResult.errors.some((e) => e.severity === 'error')

  /** 取高保真音源 ArrayBuffer（adj416：缓存 → 桌面安装目录内置 SF2 → 联网下载并写回缓存；
   *  adj729：嵌入版里最优先取**插件目录**那份 —— 宿主给 URL，随文库一起走） */
  const ensureHqBank = async (): Promise<ArrayBuffer> => {
    // adj1011：取当前选中的库（原来是无参 `getHqLibrary()` ⇒ 永远导出默认库的声音）
    const lib = resolveActiveLibrary(playbackHqLibrary).lib
    const { bank } = await resolveHqBank(lib, hqCacheRef.current, hostBankUrl(lib.id))
    return bank
  }

  /**
   * adj873（T-3）：按「导出范围」把渲染好的页面裁到所选画布口径。
   *
   * · `page`（默认）⇒ **原样返回**（保持既有行为，一个字都不动 ✓）；
   * · `score` ⇒ 用**预览区已渲染的 SVG 实测墨迹盒**（`measureInkFromPreview`，排除白底、逐元素 `getBBox` 求并集），
   *   再调引擎 `rangeBox({ range:'score' })` 算盒 + `applyRangeToSvg()` 改外框 ——
   *   **几何只走引擎那一份**，这里绝不自算留白/包围盒 ✗（AGENTS §六之二·4）。
   *   量不到墨迹（预览没渲染过）⇒ **明确报错**并提示"先显示一次谱面"，**不许静默给整页图** ✗。
   */
  const applyRange = (pages: string[]): string[] => {
    if (exportRange === 'page') return pages
    const inks = measureInkFromPreview()
    return pages.map((svg, i) => {
      const vb = readViewBoxOf(svg)
      const r = rangeBox({ range: 'score', pageW: vb?.[2] ?? 0, pageH: vb?.[3] ?? 0, ink: inks[i] ?? null })
      if (!r.ok) throw new Error(`${exportCopy.rangeNoInk}${r.reason ?? '未知原因'}`)
      return applyRangeToSvg(svg, r.box)
    })
  }

  const getPages = (): string[] => {
    if (hasError) throw new Error(exportCopy.blockedByError)
    // adj647：导出与预览共用同一份宿主字体实测（否则导出的 PDF/SVG 与预览版面不一致）
    const fm = measureFontMeta(pageConfig)
    /**
     * adj1002（用户 2026-10-19）：「导出背景」是**两项独立开关**——
     *  ① 底色（透明/白/纸色）由 `svgToCanvas` 的 `bg` 参数处理（见下方 `bgOf`）；
     *  ② **背景图/水印**在这里控制：默认**不带**（把 `bgEnabled` 临时置 false 渲染，
     *     不改用户设置）。这样"页面只有部分背景图"时，露出来的边距是**纸色**而不是白块，
     *     而"不带图"档导出的就是干净纸底。
     */
    const cfg = exportBgImage ? pageConfig : { ...pageConfig, bgEnabled: false }
    const layout = layoutScore(parseResult, cfg, defaultInstrumentRef, fm.layout)
    /**
     * adj965（方案 OVL，EP-10）：导出与预览**共用同一份**水印/背景资源（否则会出现"预览有、导出没有"）。
     * ⚠ adj1002：这里**始终**走 `withOverlay`（保持三处同源，闸门 `adj965` 守着这一点）；
     * "不带背景图"只靠把 `bgEnabled` 置 false 实现——那是渲染层的开关，不能让 overlay 链路分叉。
     */
    return applyRange(renderScoreToSvg(layout, withOverlay(fm.render)))
  }

  /**
   * adj1002：导出底色（口径与取值都在纯函数 `exportBgColor` 里，便于 smoke 断言）。
   * · `none`（默认）⇒ 透明：PNG 传 `null`（真透明），JPG/PDF 无透明通道 ⇒ 落白；
   * · `white` ⇒ 白；
   * · `paper` ⇒ **当前纸色档位**（浅色 关/轻/中 = 白 / #FDFBF5 / #F7EFDD）。
   *   深色主题不参与导出（用户口径：导出永远按浅色），所以只取浅色档位。
   */
  const bgOf = (fmt: 'png' | 'jpg' | 'pdf'): string | null => exportBgColor(exportBg, previewSoften, fmt)

  const downloadJps = () => {
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${baseName}.jps`
    a.click()
    URL.revokeObjectURL(url)
  }

  const run = async (key: ExportKey, fn: () => void | Promise<void>) => {
    setBusy(key)
    setError(null)
    // 发布任务名 → 状态栏动态指示（切走/关掉 dock 也看得到）
    setExportJob(JOB_LABEL[key])
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      setExportJob(null)
    }
  }

  /** 8 个导出目标：一键一项，按钮等宽自适应（宽时一行多个） */
  const items: { key: ExportKey; label: string; ext: string; run: () => void }[] = [
    {
      key: 'svg',
      label: exportCopy.svgLabel,
      ext: '.svg',
      run: () => run('svg', () => {
        const pages = getPages()
        pages.forEach((s, i) => exportSvg(s, pages.length > 1 ? `${baseName}-${i + 1}.svg` : `${baseName}.svg`))
      }),
    },
    { key: 'png', label: exportCopy.pngLabel, ext: '.png', run: () => run('png', async () => exportPng(getPages(), baseName, imgScale, bgOf('png'))) },
    { key: 'jpg', label: exportCopy.jpgLabel, ext: '.jpg', run: () => run('jpg', async () => exportJpg(getPages(), baseName, imgScale, bgOf('jpg'))) },
    {
      // adj626（用户要求）：PDF 改走**系统打印 → 另存为 PDF**——矢量输出、放大不糊；
      // 打印走**当前窗口**（`window.print()`），不开新窗口 ⇒ 不存在"浏览器拦截新窗口"的问题。
      // 与 `Ctrl+P` / 菜单「打印」共用 `printScore()`（同一份页面、同一个默认文件名 = 第一个 Z:）。
      key: 'pdf',
      label: exportCopy.pdfLabel,
      ext: '.pdf',
      run: () => run('pdf', () => printScore()),
    },
    {
      // 位图 PDF 保留为二级入口（不经对话框一键出文件；清晰度跟随上方档位）
      key: 'pdfImg',
      label: exportCopy.pdfImageLabel,
      ext: '.pdf',
      run: () => run('pdfImg', () => exportPdf(getPages(), baseName, imgScale, bgOf('pdf'))),
    },
    {
      // adj289：MIDI——复用播放序列（含反复展开），多声部每声部一条音轨
      key: 'midi',
      label: exportCopy.midiLabel,
      ext: '.mid',
      run: () => run('midi', () => {
        const layout = layoutScore(parseResult, pageConfig, defaultInstrumentRef)
        const bpm = inferBpm(parseResult)
        const seq = buildPlaySequence(parseResult, layout, bpm, undefined, defaultInstrumentRef)
        downloadBytes(eventsToMidi(seq.events, { bpm, title: parseResult.header.titles[0] ?? baseName }), `${baseName}.mid`, 'audio/midi')
      }),
    },
    {
      // adj345：WAV/MP3——SpessaSynth 高保真离线渲染（与试听一致），免音色库直接播放
      key: 'wav',
      label: exportCopy.wavLabel,
      ext: '.wav',
      run: () => run('wav', async () => {
        const layout = layoutScore(parseResult, pageConfig, defaultInstrumentRef)
        const bpm = inferBpm(parseResult)
        const seq = buildPlaySequence(parseResult, layout, bpm, undefined, defaultInstrumentRef)
        const buf = await renderToAudioBuffer(seq.events, await ensureHqBank(), { bpm, title: parseResult.header.titles[0] ?? baseName })
        downloadBytes(audioBufferToWav(buf), `${baseName}.wav`, 'audio/wav')
      }),
    },
    {
      key: 'mp3',
      label: exportCopy.mp3Label,
      ext: '.mp3',
      run: () => run('mp3', async () => {
        const layout = layoutScore(parseResult, pageConfig, defaultInstrumentRef)
        const bpm = inferBpm(parseResult)
        const seq = buildPlaySequence(parseResult, layout, bpm, undefined, defaultInstrumentRef)
        const buf = await renderToAudioBuffer(seq.events, await ensureHqBank(), { bpm, title: parseResult.header.titles[0] ?? baseName })
        downloadBytes(audioBufferToMp3(buf), `${baseName}.mp3`, 'audio/mpeg')
      }),
    },
    { key: 'jps', label: exportCopy.jpsLabel, ext: '.jps', run: downloadJps },
  ]

  return (
    <div className="dock-panel export-panel">
      {/* adj466：**选项与动作分成两行**（此前按"信息左/操作右"挤在一行，导出这里读起来更别扭）。
          第一行 = 图片清晰度 + 说明；第二行 = 导出动作（auto-fit 等宽网格，dock 越宽一行放下越多）。
          面板默认高度由 ToolDock 实测"能显示全"的高度给出。 */}
      <div className="dock-fields export-options">
        <label className="dock-field">
          <span className="dock-field-label">{exportCopy.scaleLabel}</span>
          <select className="dock-select" value={imgScale} onChange={(e) => setImgScale(Number(e.target.value))}>
            <option value={2}>2x 标准</option>
            <option value={4}>4x 高清</option>
            <option value={6}>6x 超清</option>
          </select>
        </label>
        {/* adj873（T-3）：导出范围——默认「页面」，保持既有行为；「谱面」= 墨迹 + 每边 2px */}
        <label className="dock-field">
          <span className="dock-field-label">{exportCopy.rangeLabel}</span>
          <select
            className="dock-select"
            value={exportRange}
            onChange={(e) => setExportRange(e.target.value === 'score' ? 'score' : 'page')}
          >
            <option value="page">{exportCopy.rangePageOption}</option>
            <option value="score">{exportCopy.rangeScoreOption}</option>
          </select>
        </label>
        <span className="dock-muted">{exportCopy.scaleHint}</span>
        <span className="dock-muted">{exportCopy.rangeHint}</span>
        {/*
          adj1002（用户 2026-10-19 要求）：**导出背景**两项独立开关——
          ① 底色（默认**透明**；纸色跟随当前纸色档位）；
          ② 是否带**背景图/水印**（默认**不带**）。
          "页面只有部分背景图"时，带图档的边距露出来的就是纸色，不会出现白块。
        */}
        <label className="dock-field">
          <span className="dock-field-label">{exportCopy.bgLabel}</span>
          <select
            className="dock-select"
            value={exportBg}
            onChange={(e) => setExportBg((e.target.value as 'none' | 'white' | 'paper') ?? 'none')}
          >
            <option value="none">{exportCopy.bgNone}</option>
            <option value="white">{exportCopy.bgWhite}</option>
            <option value="paper">{exportCopy.bgPaper}</option>
          </select>
        </label>
        <label className="dock-field export-bg-image">
          <input type="checkbox" checked={exportBgImage} onChange={(e) => setExportBgImage(e.target.checked)} />
          <span>{exportCopy.bgImageLabel}</span>
        </label>
        <span className="dock-muted">{exportCopy.bgHint}</span>
      </div>
      <div className="dock-actions export-actions">
        {items.map((it) => (
          <button key={it.key} type="button" className="btn" onClick={it.run} disabled={busy !== null} title={it.label}>
            <span className="export-btn-text">{busy === it.key ? exportCopy.busy : it.label}</span>
            <span className="export-btn-ext">{it.ext}</span>
          </button>
        ))}
      </div>
      {/* adj1195：乐谱库上传用的 zip（不是普通图片/音频导出，走独立对话框） */}
      <div className="dock-field">
        <button type="button" className="btn" onClick={() => openModal('package')} disabled={busy !== null}>
          {scorePackageCopy.title}
        </button>
        <span className="dock-muted">zip：meta / README / jps / 背景水印</span>
      </div>
      {/* adj1065：动态谱视频 = 预览区相机位（同一套预览/声音/生成视频） */}
      {/* adj1078：整块只在桌面壳出现；网站/插件不显示入口与相机位 */}
      {dynamicVideoEnabled && (
        <div className="dock-field">
          <button
            type="button"
            className="btn"
            onClick={() => {
              // adj1155/adj1165：不带参数 ⇒ 沿用相机位上次的标记段/音色；
              // 要整曲或换段在相机位里选。试听入口才把当前段作为参数带进来。
              openDynamicCamera()
            }}
            disabled={busy !== null}
          >
            动态谱视频
          </button>
          <span className="dock-muted">在预览区打开相机位（9:16 / 1:1 / 16:9）；可生成视频</span>
        </div>
      )}
      {/* adj1264：连续动态谱（单行横滚 + 背景视频）——方案 §八 P8：导出面板也放一条入口 */}
      {dynamicVideoEnabled && (
        <div className="dock-field">
          <button
            type="button"
            className="btn"
            onClick={() => openModal('linearSync')}
            disabled={busy !== null}
          >
            {linearSyncCopy.title}
          </button>
          <span className="dock-muted">{linearSyncCopy.entryHint}</span>
        </div>
      )}
      {/* adj626：说明 PDF 两条路的差别（默认那条走系统打印对话框，故必须讲清怎么选） */}
      <div className="dock-muted">{exportCopy.pdfPrintHint}</div>
      {hasError && <div className="dock-error">⚠ {exportCopy.errorHint}</div>}
      {error && <div className="dock-error">✗ {error}</div>}
    </div>
  )
}
