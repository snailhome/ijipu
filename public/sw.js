/* iJipu PWA Service Worker（adj155：可安装为浏览器应用）
 * 策略：
 *  - 导航请求（HTML）：network-first，离线回退**该页面自己的缓存**
 *  - 静态资源（/assets/* 带 hash）：cache-first，后台刷新缓存
 *  - manifest / 图标 / favicon：cache-first
 * 版本号变化时 activate 清理旧缓存（adj192：升 v3，强制清掉旧 CSS/字体缓存）。
 * adj417：图标集中在 `/icons/`（`public/icons/`），dist 根目录不再散落几十个 png。
 *
 * ## adj876（官网分层）改了四处
 *
 * 站点从"根路径就是应用"变成四页：`/`（介绍首页）、`/app/`（应用）、
 * `/manual/`（手册）、`/syntax/`（语法）——**adj905x 又加了 `/plugin/`（插件手册）、
 * adj948 再加 `/cli/`（命令行手册）**，同一套口径。
 * 对 SW 的影响：
 *
 * ① **缓存名 v3 → v4**：`/index.html` 这个键的含义变了（以前是应用、现在是首页），
 *    不换名会让老用户一直命中缓存的旧应用 HTML，而它引用的 hash 资源在新构建里已经不存在
 *    ⇒ 白屏。换名顺手清掉旧缓存。
 *    ⚠ 原计划"迁移 `/fonts/*` 缓存以免重下 30MB 字体"——**实测不需要**：
 *      `/fonts/*.otf` 早在 adj194 就移除了（改用系统字体栈，见 `engine/fonts.ts`），
 *      全仓库已无该路径的引用，那段分支是死代码（本次一并删除）。所以换缓存名是**零代价**的。
 * ② **导航回退按路径分类**：以前所有导航离线都回退 `/index.html`，
 *    分层后那会把 `/app/` 的请求喂成首页 HTML ⇒ 白屏。现在走 `fallbackFor()`。
 * ③ **写缓存用各自的键**：以前一律写成 `/index.html` 键，会把应用页的 HTML 存成首页的键。
 * ④ **PRECACHE 换口径**：预缓存的是"离线时打开也应当可用的页面"——
 *    `/app/index.html`（PWA 的 `start_url` 是 `/app/`，必须离线可用）与 `/index.html`
 *    （首页正文写在 HTML 里，即使 JS/CSS 没进缓存也读得成）。
 *    `/manual/`、`/syntax/`、`/plugin/`、`/cli/` **不预缓存**：它们的正文靠 JS 渲染，
 *    只预缓存一个空骨架没有意义（访问过之后自然会进缓存，离线再看就能用）。
 *
 * 注意：`/assets/*` 带 hash，**不做预缓存清单**（清单得在构建期注入才有意义）；
 * 沿用既有口径"访问过就离线可用"。
 */
const CACHE = 'jps-shell-v4'
/**
 * adj539：**桌面壳里绝不用 SW**（Tauri 在 Windows 用 `http(s)://tauri.localhost`，是安全上下文、
 * SW 本可注册，但资源随二进制内嵌，SW 只会带来陈旧缓存）。历史版本注册过的 SW 曾在壳里造成**白屏**：
 * 它在 SW 上下文里取不到 Tauri 自定义协议 → 回退缓存的旧 `index.html` → 旧 HTML 引用的
 * `/assets/<旧 hash>.js` 新版本已不存在 → 资源协议回 index.html（text/html）→ 模块脚本 MIME 失败。
 * 而"注销 SW"的补救代码在页面 JS 里、页面 JS 又被该 SW 挡住 ⇒ 死锁。
 * 故这里加一道**自毁保险**：一旦发现自己在桌面壳里，就清空缓存并注销自己，且不拦截任何请求。
 * （Rust 侧 `purge_stale_service_worker` 会在启动前直接删掉它的存储，这里是第二道防线。）
 */
const IN_DESKTOP_SHELL = self.location.hostname === 'tauri.localhost'

/**
 * 导航离线时该回退到哪个缓存键。
 *
 * ⚠ `scripts/smoke.mts` 会把 `#region fallbackFor` 到 `#endregion` 之间的**原文**抠出来
 * 直接执行并断言 —— 这样断言的就是线上跑的同一段代码，而不是"抄一份逻辑到测试里"
 * （抄一份的结果是：改了这边忘了那边，测试全绿线上白屏）。
 * ⇒ **保留这对标记**，也别在这个区间里引用外部变量。
 */
// #region fallbackFor
function fallbackFor(pathname) {
  if (pathname === '/app' || pathname.startsWith('/app/')) return '/app/index.html'
  if (pathname === '/manual' || pathname.startsWith('/manual/')) return '/manual/index.html'
  if (pathname === '/syntax' || pathname.startsWith('/syntax/')) return '/syntax/index.html'
  if (pathname === '/plugin' || pathname.startsWith('/plugin/')) return '/plugin/index.html'
  // adj948（新增 `/cli/` 命令行手册）：漏了这条 ⇒ 离线打开 /cli/ 会被喂成首页 HTML（白屏）
  if (pathname === '/cli' || pathname.startsWith('/cli/')) return '/cli/index.html'
  /**
   * adj1190（曲库）：`/scores/` 是构建期生成的静态页。
   * 详情页有自己的一份 HTML，缓存键必须是**它自己**（`/scores/x/index.html`），
   * 否则所有详情页会共用同一个键、离线打开谁都变成列表。
   */
  if (pathname === '/scores' || pathname === '/scores/') return '/scores/index.html'
  if (/^\/scores\/[^/]+\/?$/.test(pathname)) {
    return pathname.endsWith('/') ? `${pathname}index.html` : `${pathname}/index.html`
  }
  if (pathname.startsWith('/scores/')) return '/scores/index.html'
  if (pathname === '/copyright' || pathname === '/copyright/') return '/copyright/index.html'
  return '/index.html'
}
// #endregion

const PRECACHE = [
  '/app/index.html', // PWA 启动页（manifest 的 start_url = /app/）——离线必须打得开
  '/index.html', // 首页：正文在 HTML 里，CSS/JS 没缓存也能读
  '/manifest.webmanifest',
  '/icons/Jianpu.ico',
  '/icons/Jianpu.png',
  '/icons/pwa-192.png',
  '/icons/pwa-512.png',
  '/icons/good.png',
]
/* adj408：按钮 PNG 图标（`public/icons/*.png`，约 60KB）——首屏渲染就会用到，离线时必须命中缓存。
   单独**逐个**预热而**不并进 PRECACHE**：`addAll` 是"任一失败则整体失败"，图标文件名是中文，
   万一编码/改名对不上就会让整个 install 失败 → 更新提示再也弹不出来（E-2026-140），
   故这里用非致命写法（单个失败忽略）。
   adj417：清单必须与 `src/ui/toolIcons.ts` 的 ICON_FILES 完全一致（smoke 有断言兜底——
   此前这里漏了「暂停」「下载」，属于清单漂移）。
   adj456：**再次漂移**——adj426 新增的「自动主题」「浅色主题」「深色主题」三个图标没进这份清单，
   表现为 PWA 离线/首次安装后顶栏「浅深模式」按钮**空白**（图标是 CSS mask 的 URL，缺文件即无形状）。
   本次补齐并把该断言从"基线里的一条已知失败"变成"零容忍"（smoke 现在 0 失败）。
   adj458：拆分两个方向改用专属图标（「左右」「上下」）、「导出」改用专属图标（不再借用「下载」）、
   「编码」「预览」「输入条」也各自换成对应图标（不再借用「文件」「查看」「键盘」）——
   清单随之一并替换/移除。 */
const ICON_FILES = ['菜单', '编码', '左右', '上下', '预览', '排版', '播放', '停止', '暂停', '设置', '谱面设置', '导出', '折行', '字体', '爱心', '下', '上', '更多', '输入', '自动主题', '浅色主题', '深色主题', '工作区', '底栏展开', '底栏收起', '左', '右', '导入', '告警', '关于', '切换工作区', '查找']
const ICONS = ICON_FILES.map((n) => `/icons/${n}.png`)

self.addEventListener('install', (event) => {
  // adj539：桌面壳里不预热、直接进入等待（配合 activate 的自毁逻辑）
  if (IN_DESKTOP_SHELL) {
    event.waitUntil(self.skipWaiting())
    return
  }
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) =>
        c.addAll(PRECACHE).then(() =>
          Promise.all(
            ICONS.map((u) =>
              /**
               * adj457：图标**强制走网络校验**（`cache: 'reload'`）再写缓存。
               * 起因：图标文件名固定不带 hash，`cache.add()` 的 fetch 可能命中**浏览器 HTTP 缓存**
               * （部署侧通常 `max-age=600`）→ 新构建把图标换了图，SW 却把**旧图**写进缓存并一直用下去
               * （要等下一次构建触发 SW 更新才可能换掉），用户会以为"换了图没生效"。
               * 仍然**逐个非致命**（单个失败忽略）——中文文件名 + `addAll` 的"任一失败全失败"
               * 曾让整个 install 挂掉、更新提示再也弹不出来（E-2026-140）。
               */
              fetch(new Request(u, { cache: 'reload' }))
                .then((res) => (res.ok ? c.put(u, res) : undefined))
                .catch(() => undefined),
            ),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  // adj539：桌面壳里**清空所有缓存并注销自己**（自毁保险，见文件顶部注释）
  if (IN_DESKTOP_SHELL) {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))
        await self.registration.unregister()
        await self.clients.claim()
      })(),
    )
    return
  }
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  // adj539：桌面壳里**完全不拦截**（自毁保险，见文件顶部注释）——让 Tauri 资源协议自己处理
  if (IN_DESKTOP_SHELL) return
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return // 仅同源（不缓存跨域请求）

  // 导航请求：网络优先，离线回退**该页面自己的缓存**（adj876：按路径分类，别一律回首页）
  if (req.mode === 'navigate') {
    const key = fallbackFor(url.pathname)
    event.respondWith(
      fetch(req)
        .then((res) => {
          // 只缓存成功响应；且按"页面自己的键"存（adj876：以前一律存成 /index.html）
          if (res && res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(key, copy))
          }
          return res
        })
        .catch(() =>
          caches.match(key).then((hit) => {
            if (hit) return hit
            // 曲库详情页离线第一次打开：退回列表，而不是给一张空白
            if (key.startsWith('/scores/') && key !== '/scores/index.html') {
              return caches.match('/scores/index.html')
            }
            return undefined
          }),
        ),
    )
    return
  }

  // 静态资源与 manifest/图标：缓存优先，后台更新
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(req, copy))
          }
          return res
        })
        .catch(() => hit)
      return hit || network
    }),
  )
})
