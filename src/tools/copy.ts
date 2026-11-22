/**
 * tools/copy.ts — `/tools/` 音视频工具的全部用户文案（adj1316）
 *
 * 为什么单放一份、而不放进 `src/brand/copy.ts`：那一份是**应用**的文案表（几百个键），
 * 这个页面是独立的静态页（不加载应用），俩页面首包互不相干；混在一起会让"改工具文案"
 * 去动应用的受测文件。规矩照旧：**页面里不许出现中文字面量**，全从这儿取。
 */
export const toolsCopy = {
  brand: '音视频工具',
  brandSub: 'iJipu Tools',
  backHome: '首页',
  openApp: '打开应用',
  docs: '文档',
  intro: '三个页签各管一件事，都在你自己的浏览器里算：文件不经过任何服务器，关掉页面就没了。',
  localBadge: '全部本机处理 · 不上传',

  tabs: {
    merge: '音视频合并',
    split: '有声视频拆分',
    clip: '音频片段截取',
  },

  /** 能力闸门：这个浏览器缺东西时给出的说明（不隐藏页签，但按钮会禁用并说清楚为什么） */
  capability: {
    noMux:
      '这个浏览器不支持视频容器读写（WebCodecs）。合并与拆组需要新版 Chrome / Edge / Safari 16.4+，' +
      '或者用爱出片的桌面版。片段截取不受影响。',
    noReencode:
      '这个浏览器只能"原样搬运"、不能重编码：音频请用 m4a / mp3（换成 WAV 会需要重编码），' +
      '「与原声混音」也用不了。',
    noAudio: '这个浏览器不支持 WebAudio，画不了波形、也导不出音频。',
  },

  merge: {
    title: '视频合并音频',
    hint:
      '把视频和一条音频合成一个带声音的视频。画面不重编码（体积≈原视频）；音频默认也原样保留（体积≈原音频），' +
      '只有混音或换了格式时才按下面的码率重编。',
    video: '视频文件',
    pickVideo: '选择视频…',
    audio: '音频文件',
    pickAudio: '选择音频…（可空）',
    mode: '音频处理',
    modeReplace: '替换原声',
    modeMix: '与原声混音',
    modeMixSlow: '与原声混音（要重编码，慢）',
    bitrate: '音频码率',
    bitrateSource: '跟随源文件',
    run: '生成带音频的视频',
    running: '生成中…',
    needVideo: '先选一个视频文件',
    done: (name: string) => `已保存：${name}`,
    suffixReplace: '-替换音频',
    suffixMix: '-混音',
  },

  split: {
    title: '拆分有声视频',
    hint:
      '从一个带音频的视频里分别取出画面和声音。画面整包搬运、不掉画质；音频默认原样搬（m4a/aac，体积=原音轨），' +
      '也可以另存成 WAV 拿去别的软件里处理。',
    video: '视频文件',
    pickVideo: '选择要拆分的视频…',
    runVideo: '导出无声视频（MP4）',
    runVideoBusy: '导出中…',
    runAudio: '提取音频（原样 m4a）',
    runAudioBusy: '提取中…',
    runWav: '提取音频（WAV）',
    needVideo: '先选一个要拆分的视频文件',
    noAudioTrack: '这个文件里没有音频轨',
    suffixVideo: '-无声',
    suffixAudio: '-音频',
    done: (name: string) => `已保存：${name}`,
  },

  clip: {
    title: '音频片段截取导出',
    hint:
      '载入一首歌，拖出要的那一段，按 WAV 或 MP3 导出来。也可以把几段都标出来，一次导成一包。' +
      '播放与波形都在本机算，长曲子的载入要等几秒。',
    file: '音频文件',
    pick: '选择音频…（也可以选视频，取它的声音）',
    needFile: '先选一个音频文件',
    loading: '正在读取音频…',
    loaded: (dur: string, rate: string) => `已载入：${dur}，${rate}`,
    play: '播放',
    pause: '暂停',
    playSel: '播放选区',
    stop: '回到开头',
    selection: '选区',
    /** 直接用当前选区导出时，文件名里带上这个称呼 */
    selLabel: '选区',
    noSelection: '还没有选区：在波形上按住拖一下',
    selRange: (a: string, b: string, d: string) => `${a} → ${b}（${d}）`,
    nudgeStart: '起点',
    nudgeEnd: '终点',
    /** adj1317：起止点可以各自独立落在播放头上，不必先拖选区 */
    headStart: '起点＝播放头',
    headEnd: '终点＝播放头',
    nudgeHint:
      '微调只动你点的那一边（10 毫秒 / 100 毫秒）；波形上也能直接抓住选区的起点/终点边拖。' +
      '点一下波形只挪播放头，不会清掉选区。',
    addMark: '把选区加成一段',
    marks: '标记段',
    noMarks: '还没有标记段。定好起点和终点后，点「把选区加成一段」。',
    markName: '段名',
    /** 新加的标记段默认名（用户只改名字，不用每次手打） */
    defaultMark: (n: number) => `段 ${n}`,
    loop: '循环选区',
    /** adj1318：整套播放/试听口径从爱出片对拍台搬过来，复听是它自带的那一个 */
    audition: '复听（前 3 秒 / 后 5 秒）',
    auditionHint: '复听会把刚才那几秒循环放，用来反复确认卡点；再点一次取消。',
    viewLabel: '视野',
    viewAll: '整曲',
    viewHint: 'Ctrl + 滚轮 = 在鼠标那一处放大/缩小波形（放大后时间标尺也跟着变细）。',
    /** adj1319：放大之后用下面那条滚动条挪位置 */
    scrollHint: '拖动这条滚动条可以左右移动波形（放大之后才出现）',
    /** adj1319：波形被点过之后，空格就是播放/暂停 */
    spaceHint: '点一下波形让它拿到焦点后，按空格＝播放 / 暂停。',
    /** adj1319：复听留下的临时时点，正常播放时自动消失 */
    anchorHint: '金色虚线是点「复听」时你听到的那一点，正常播放后就取消。',
    suffixZip: '-片段',
    pickMark: '选中',
    playMark: '播放',
    exportMark: '导出',
    deleteMark: '删掉',
    exportSel: '导出当前选区',
    exportAll: '把全部标记段打成一包（ZIP）',
    format: '导出格式',
    formatWav: 'WAV（无损，体积大）',
    formatMp3: 'MP3（128 kbps，体积小）',
    encoding: '正在编码…',
    saved: (name: string) => `已保存：${name}`,
    packed: (n: number, name: string) => `已保存 ${n} 段：${name}`,
    emptyMarks: '还没有标记段可导',
    noSel: '先把起点和终点定下来：拖一下波形，或用上面两个「＝播放头」按钮各点一次',
    tooShort: '选区太短了（至少 10 毫秒）',
  },

  common: {
    failed: (msg: string) => `失败：${msg}`,
    cancel: '取消',
    saving: '正在保存…',
    privacy: '文件只在这台设备的浏览器里读写，不会上传。',
    /** 文件名兜底（用户没给名字 / 去掉扩展名后是空串时用） */
    fallback: { audio: '音频', untitled: '未命名' },
    /** 解析/导出失败时抛给用户的错（`mux.ts` 抛、`common.failed` 包一层） */
    errors: {
      unreadable: '无法读取这个媒体文件（格式不支持或文件损坏）',
      videoTrack: '这个文件里没有视频轨',
      audioTrack: '选中的音频文件里没有音轨',
      noOutput: '导出没有产生数据',
    },
    /** 进度行文案（长任务里只有这一行在动） */
    progress: {
      copyVideo: '正在搬运视频（不重编码）…',
      encodeVideo: '正在编码视频…',
      encodeAudio: '正在编码音频…',
      copyAudio: '正在搬运音频（不重编码）…',
      muxMp4: '正在封装 MP4…',
      reencodeVideo: '视频直通失败，正在重新编码…',
      muxM4a: '正在封装 M4A…',
      readAudio: '正在读取音频…',
      decodeAudio: '正在解码音频…',
      writeWav: '正在写 WAV…',
    },
  },
} as const
