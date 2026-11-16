/**
 * ui/topbarFold.ts — 顶栏「放不下就收进更多」的**纯算式**（adj530）
 *
 * 为什么单独成文件：这段宽度预算在本项目反复踩坑（E-2026-193 / adj453——漏扣一个常驻按钮、
 * 少算一个 flex 间距，最右侧的「更多」就被顶出视口；CSS 一改、写死的常量就过期）。
 * 抽成纯算式后：① 参数全是实测值，CSS 怎么调都自动跟上；② smoke 可以拿一张"每个按钮多宽"的
 * 表直接断言"谁被折叠、折叠先后"，不必靠正则去盯组件源码文本。
 *
 * 职责只有一件：给定各项宽度与可用宽，按**可见优先级**从最低的一位开始折叠，直到放得下；
 * 返回被折叠的键（**按折叠先后**，即优先级从低到高）。渲染/文案/交互一律不在这里。
 */

/** 「支持」的键——它独立成组（不在功能组/编辑设置组里），但同样参与折叠 */
export const TOPBAR_DONATE_KEY = 'donate'

/** 顶栏里除按钮槽位之外的**固定在流子项数**：Logo、汉堡、工具条 */
export const TOPBAR_FIXED_KIDS = 3

/** 组框的盒子开销（左右 padding + 左右 border）与组内按钮间距——均由调用方实测传入 */
export interface BoxMetrics {
  overhead: number
  gap: number
}

export interface FoldInput<K extends string = string> {
  /**
   * **可见优先级**，靠前 = 越晚被折叠（数组末位最先被折叠）。
   * 调用方需先滤掉"当前不适用"的按钮（例如编码视图下的比率组、窄屏下的字体按钮）——
   * 不适用的按钮不占宽度预算，也就不该出现在这里。
   */
  priority: readonly K[]
  /** 每个按钮的实测宽（键 → px；查不到按 0 计） */
  widthByKey: ReadonlyMap<string, number>
  /** 功能按钮组内的显示顺序（已滤掉不适用项） */
  fnKeys: readonly K[]
  /** 编辑设置组内的显示顺序（已滤掉不适用项） */
  editKeys: readonly K[]
  fnBox: BoxMetrics
  editBox: BoxMetrics
  /** 工具条自身的开销与两组之间的间距 */
  toolbar: BoxMetrics
  /** 顶栏左侧固定项总宽（Logo + 汉堡，含外边距） */
  fixedW: number
  /** 「支持」槽位宽（含外边距）——与它当前是否显示无关，恒预留 */
  donateW: number
  /**
   * 「右侧栏开关」槽位宽（含外边距）——adj1295 新增的**常驻**按钮。
   *
   * 它是"开关右侧操作栏"的唯一入口，用户口径是**常驻**（不许躲进「更多」，
   * 否则窄屏下"想开右栏"得先点开更多）⇒ 不进折叠链，但**必须扣宽度预算**
   * （`adj453` 的原始教训：漏扣一个常驻按钮，最右侧的「更多」就被顶出视口）。
   */
  rightDockW: number
  /** 「更多」槽位宽（含外边距）——同上，恒预留 */
  moreW: number
  /** 顶栏自身左右内边距 */
  pad: number
  /** 顶栏 flex 间距 */
  gap: number
  /** 顶栏可用总宽（`clientWidth`） */
  totalW: number
  /** 安全余量：抵消亚像素取整（getBoundingClientRect 小数累加）带来的溢出 */
  safe: number
}

/**
 * 按可见优先级折叠，返回被折叠的键（按折叠先后）。
 *
 * 判定"放得下"的口径（顶栏是一行 flex，工具条自身 `overflow:hidden` 是安全阀）：
 *   顶栏整行 = Logo+汉堡 + 工具条内容宽 + 支持? + 更多? + 各子项间距（子项数 − 1）+ 安全余量
 * 其中「更多」只在**确有按钮被折叠**时出现，所以两种情形都要能判定——只按一种算，要么白扣
 * 一个槽位（明明还放得下却先折叠了按钮），要么反过来溢出。
 */
export function foldKeys<K extends string>(o: FoldInput<K>): K[] {
  const w = (k: string): number => o.widthByKey.get(k) ?? 0
  /** 组框宽 = 盒子开销 + 按钮宽和 + 按钮间间距×(n−1)；空组不占位（CSS `:empty` 也不占位） */
  const groupW = (keys: readonly string[], b: BoxMetrics): number =>
    keys.length === 0 ? 0 : b.overhead + keys.reduce((s, k) => s + w(k), 0) + (keys.length - 1) * b.gap
  const visible = new Set<string>(o.priority)
  const fits = (withMore: boolean): boolean => {
    const fn = o.fnKeys.filter((k) => visible.has(k))
    const ed = o.editKeys.filter((k) => visible.has(k))
    const toolbarW =
      o.toolbar.overhead +
      groupW(fn, o.fnBox) +
      (fn.length > 0 && ed.length > 0 ? o.toolbar.gap : 0) +
      groupW(ed, o.editBox)
    // adj1295：「右侧栏开关」是**常驻**槽位（不进折叠链，见 TopBar 的渲染）——
    // 它一位不扣，「更多」就容易被顶出视口（与 adj453 漏扣「支持」是同一类账）。
    const kids = TOPBAR_FIXED_KIDS + (visible.has(TOPBAR_DONATE_KEY) ? 1 : 0) + (withMore ? 1 : 0) + 1
    const total =
      o.fixedW +
      toolbarW +
      (visible.has(TOPBAR_DONATE_KEY) ? o.donateW : 0) +
      o.rightDockW +
      (withMore ? o.moreW : 0) +
      o.gap * (kids - 1) +
      o.safe
    return total <= o.totalW - o.pad
  }
  const hidden: K[] = []
  if (!fits(false)) {
    // 从可见优先级**最低**（数组末位）开始折叠；一旦有按钮被折叠，「更多」就要占位，
    // 之后的判定都按"有更多"算——这就是"先图标化、再从最右端逐步隐藏"的既有模式的延续。
    for (let i = o.priority.length - 1; i >= 0; i--) {
      const k = o.priority[i]
      visible.delete(k)
      hidden.push(k)
      if (fits(true)) break
    }
  }
  return hidden
}
