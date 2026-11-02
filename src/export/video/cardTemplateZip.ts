/**
 * export/video/cardTemplateZip.ts — 卡片模板的 zip 打包/解包（adj1075）
 *
 * 用户要求：模板能另存为 zip 整体打包，也能导入，方便迁移/交流。
 * 约束：**不新增第三方依赖**。ZIP 读写器已抽到 `src/export/zip.ts`（本应用配置导出也用它）。
 *
 * 包内容：
 *   card.json       —— `CardStyle`（backgroundImage 置 null，图片单独放）
 *   background.*    —— 可选，扩展名跟 data URL 的 MIME 走
 *   README.txt      —— 应用/导入说明，方便别人打开 zip 时看得懂
 */
import { normalizeCardStyle, type CardStyle } from './cardTemplates'
import { base64ToBytes, bytesToBase64, readZip, writeZip, type ZipEntry } from '../zip'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

/** adj1184（用户 2026-11-02）：导出的模板 zip 默认名统一用这个前缀 */
export const CARD_TEMPLATE_ZIP_PREFIX = 'ijipu-card-'

/**
 * 模板导出文件名：`ijipu-card-<模板名>.zip`。
 *
 * 模板名里 Windows 不允许的字符（`\ / : * ? " < > |`）替换成 `_`；
 * 名字为空时用「未命名」，避免出现 `ijipu-card-.zip`。
 */
export function cardTemplateZipNameOf(name: string | null | undefined): string {
  const safe = String(name ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 40)
  return `${CARD_TEMPLATE_ZIP_PREFIX}${safe || '未命名'}.zip`
}

interface ParsedDataUrl {
  mime: string
  ext: string
  bytes: Uint8Array
}

function parseDataUrl(url: string): ParsedDataUrl | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url)
  if (!m) return null
  const mime = m[1] || 'image/png'
  const ext = mime === 'image/jpeg' ? 'jpg' : (mime.split('/')[1] || 'png').toLowerCase()
  return {
    mime,
    ext,
    bytes: m[2] ? base64ToBytes(m[3]) : ENC.encode(decodeURIComponent(m[3])),
  }
}

/** 把一份卡片样式打成 zip（背景图 / 印章图分别单独存） */
export function createCardTemplateZip(style: CardStyle): Uint8Array {
  const files: ZipEntry[] = []
  const { backgroundImage, seal, ...rest } = style
  // adj1178：印章图片同样从配置里拿出来，单独放文件（card.json 里置 null）
  const sealForJson = seal ? { ...seal, image: null } : null
  files.push({
    name: 'card.json',
    data: ENC.encode(JSON.stringify({ ...rest, backgroundImage: null, seal: sealForJson }, null, 2)),
  })
  const image = backgroundImage ? parseDataUrl(backgroundImage) : null
  if (image) files.push({ name: `background.${image.ext}`, data: image.bytes })
  const sealImage = seal?.image ? parseDataUrl(seal.image) : null
  if (sealImage) files.push({ name: `seal-image.${sealImage.ext}`, data: sealImage.bytes })
  files.push({
    name: 'README.txt',
    data: ENC.encode(
      [
        `爱记谱 iJipu 动态谱卡片模板：${style.name || '自定义'}`,
        '导入：应用 → 动态谱视频相机位 → 卡片「管理模板…」→「导入模板 zip」。',
        'card.json 是样式；background.* 是片头/片尾背景图；seal-image.* 是印章图片。',
        '可直接改 JSON 后重新打包。',
      ].join('\n'),
    ),
  })
  return writeZip(files)
}

/** 读 zip → 卡片样式；背景图 / 印章图还原成 data URL */
export function readCardTemplateZip(zip: Uint8Array): CardStyle {
  const entries = readZip(zip)
  const card = entries.get('card.json')
  if (!card) throw new Error('zip 里没有 card.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(DEC.decode(card))
  } catch {
    throw new Error('card.json 不是有效 JSON')
  }
  const style = normalizeCardStyle(parsed as Partial<CardStyle>)
  const imageOf = (prefix: string): string | null => {
    const name = [...entries.keys()].find((n) => new RegExp(`^${prefix}\\.(png|jpe?g|webp|gif)$`, 'i').test(n))
    if (name === undefined) return null
    const ext = (name.split('.').pop() || 'png').toLowerCase()
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
    return `data:${mime};base64,${bytesToBase64(entries.get(name)!)}`
  }
  const backgroundImage = imageOf('background')
  if (backgroundImage !== null) style.backgroundImage = backgroundImage
  const sealImage = imageOf('seal-image')
  if (sealImage !== null && style.seal) style.seal = { ...style.seal, image: sealImage }
  return style
}
