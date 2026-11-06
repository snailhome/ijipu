/**
 * src/samples/index.ts — 「新建」模板（示例列表已改走线上，见 samples/online.ts）
 *
 * 2026-11-06 用户口径：应用「打开示例」的列表与源码直接从官网取；本文件不再 glob
 * `public/samples/*.jps`，只保留「新建」模板。
 *
 * adj481（用户要求）：「新建」模板同样**文件驱动**——模板就是 `src/samples/未命名.jps`，
 * 想改"新建出来的空白谱长什么样"，直接编辑那个文件即可（重跑构建生效），代码里不再内嵌模板。
 * 放在源码目录（而非 `public/`）是有意的：模板只在**构建期**被内联进产物，不需要作为静态资源发布。
 */
import { JPS_CONFIG_PREFIX } from '@ijipu/engine'

export interface SampleScore {
  id: string
  name: string
  description: string
  code: string
}

/**
 * adj481：「新建」模板 = `src/samples/未命名.jps`（**唯一来源**，改它即可改新建内容）。
 *
 * 为什么改成文件驱动：内嵌在代码里的模板每次调整都要改代码 + 重新构建，而模板本身是"用户可以随意
 * 塑形"的谱面文本（分隔注释、默认拍号、署名行、页面设置区块…），放在文件里直接编辑最省事。
 *
 * 兜底：文件被删/读不到时用下面这份**最小可解析**内容，避免新建出空文档（不是模板的"第二份副本"，
 * 只是故障兜底；要改模板请改 `src/samples/未命名.jps`）。
 */
const TEMPLATE_FALLBACK = [
  'V: 1.0',
  'B: 未命名',
  'D: C',
  'P: 4/4',
  'Q: 1 2 3 4 |',
  `${JPS_CONFIG_PREFIX}{}`,
  '',
].join('\n')

/** 构建期读入模板文件（单文件 glob，直接取值以避开 glob 键的路径写法差异） */
const TEMPLATE_FILES = import.meta.glob('./未命名.jps', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const NEW_FILE_TEMPLATE = Object.values(TEMPLATE_FILES)[0] ?? TEMPLATE_FALLBACK

/** 默认（新建）谱 —— 返回「新建」模板（adj481：内容来自 `src/samples/未命名.jps`） */
export function defaultSample(): SampleScore {
  return { id: 'new', name: '未命名', description: '', code: NEW_FILE_TEMPLATE }
}
