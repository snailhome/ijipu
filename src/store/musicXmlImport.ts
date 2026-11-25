/**
 * store/musicXmlImport.ts — MusicXML → `.jps` 的薄封装（纯函数，便于测试）
 *
 * 引擎早就有这条链：`parseMusicXmlToIR`（MusicXML → ScoreIR）→ `irToJps`（IR → `.jps`）。
 * 这里只做三件事：
 *  ① 扩展名/内容识别（`.musicxml`、`.xml`，或文本里出现 `<score-partwise>`）；
 *  ② 只把 `parse` 阶段的 **must** 当失败（坏 XML/不是 MusicXML）；转换细节的 review 提示保留下来；
 *  ③ 给出统一的文件名与提示文案，避免打开、拖放、粘贴三处各写一套。
 *
 * 不在引擎里加封装的原因：引擎的 `scoreIR/index.ts` 已把两个函数都导出了，
 * 应用层只差"识别 + 走同一段装载"，属于宿主策略，不是语法能力。
 */
import { irToJps, parseMusicXmlToIR } from '@ijipu/engine'
import type { IRIssue } from '@ijipu/engine'

export interface MusicXmlConvertOk {
  ok: true
  code: string
  /** 转换过程中产生的 review 提示（不阻断导入） */
  issues: IRIssue[]
}

export interface MusicXmlConvertFail {
  ok: false
  /** 直接给用户看的中文原因 */
  error: string
  issues: IRIssue[]
}

export type MusicXmlConvertResult = MusicXmlConvertOk | MusicXmlConvertFail

/** `.musicxml` / `.xml`（大小写不敏感）；真正的格式仍由 `parseMusicXmlToIR` 判定 */
export function isMusicXmlName(name: string | null | undefined): boolean {
  return /\.(musicxml|xml)$/i.test(name ?? '')
}

/**
 * 粘贴/拖入的文本像不像 MusicXML。
 *
 * 只看根元素 `score-partwise`（MusicXML 的最常见根）；不看 XML 声明，避免把普通 XML 误判。
 * 只看前 64K 字符：根元素一定在文件开头，没必要扫整份大文件。
 */
export function looksLikeMusicXml(text: string): boolean {
  return /<score-partwise(?:\s|>)/i.test(text.slice(0, 65536))
}

/** 把导入失败的 must 提示拼成一句人话（通常只有一条） */
function mustMessage(issues: readonly IRIssue[]): string {
  const must = issues.filter((it) => it.severity === 'must')
  if (must.length === 0) return ''
  return must.map((it) => it.message).join('；')
}

/**
 * MusicXML 文本 → `.jps` 文本。
 *
 * 失败只认 `parse` 的 must：坏 XML、不是 `score-partwise`。`irToJps` 的 issues 是
 * "某些写法没转出来"的 review 提示，仍然导入，交给用户检查谱面。
 */
export function musicXmlToJps(xml: string): MusicXmlConvertResult {
  const parsed = parseMusicXmlToIR(xml)
  const fatal = mustMessage(parsed.issues)
  if (fatal !== '') return { ok: false, error: fatal, issues: parsed.issues }

  const out = irToJps(parsed.ir)
  return { ok: true, code: out.code, issues: out.issues }
}

/** 统一的提示文案；有 review 提示时如实说数量，不谎报"完全无损" */
export function musicXmlNotice(result: MusicXmlConvertOk): string {
  const reviews = result.issues.filter((it) => it.severity === 'review').length
  return reviews > 0
    ? `已把 MusicXML 转成 .jps（${reviews} 条转换提示，请检查谱面）`
    : '已把 MusicXML 转成 .jps'
}

/** 导入后的文件名（不带扩展名；保存走另存为/导出） */
export const MUSIC_XML_IMPORT_NAME = 'MusicXML 导入'
