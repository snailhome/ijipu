/**
 * nsis/hooks.nsh — iJipu NSIS 安装/卸载钩子（adj538）
 *
 * 为什么需要这个文件：Tauri 的 NSIS 模板只做两件事——安装时 `APP_ASSOCIATE`（写
 * `Software\Classes\.jps` + 我方 ProgID 的 `shell\open\command`），卸载时 `APP_UNASSOCIATE`
 * （把 `.jps` 默认值还原成安装前的、删我方 ProgID 键）。经查源码与**本机真实生成的
 * `installer.nsi`/`FileAssociation.nsh`**，它**不做**下面三件事，而这正是"卸载干净 + 右键可见"必须的：
 *   ① 不写 `Software\Classes\.jps\OpenWithProgids`（Microsoft 要求该项才会出现在「打开方式」列表里，
 *      缺了它用户只能走「选择其他应用」——上游 tauri#9803 就是这个问题，至今未修）；
 *   ② 不调用 `SHChangeNotify`（`UPDATEFILEASSOC` 宏已定义但从没被 `!insertmacro`），
 *      于是资源管理器可能继续显示旧图标/旧关联，要重启或重新登录才刷新；
 *   ③ 卸载**不删** `Software\Classes\.jps` 键本身，也不删它写入的 `<ProgID>_backup` 备份值
 *      （备份值名 = `iJipu.jps_backup`，因为 `name` 即 ProgID），于是留下永久残留。
 *
 * 设计原则（重要）：**只动我们自己写的东西**。
 *   - 只删我方的两个值名（`iJipu.jps_backup`、`OpenWithProgids` 里的 `iJipu.jps`）；
 *   - 只有在键**确实空了**（默认值为空 + 没有任何其它值 + 没有任何子键）时才删键；
 *   - 因此如果用户机器上还有别的程序注册过 `.jps`（现实中 `.jps` 也被 JPEG Stereo 图像、
 *     Java Print Service 占用），它们的内容**原样保留**，我们只是把自己摘干净。
 *   为什么不用 `DeleteRegKey /ifempty`：它**不检查值**（社区专门有"How to delete a registry key
 *   only if it has no values"的讨论与 "DeleteRegKey /IfEmpty doesn't work" 的 bug 报告），
 *   直接用它会在"键里还有别的程序的值"时把整个键删掉 → 会误伤别人。故此处改为**手工枚举**判定。
 */

/**
 * adj539：快捷方式中文名 + 备注、右键动词中文化（用户要求）
 *
 *   ① 桌面/开始菜单快捷方式：模板按 `${PRODUCTNAME}`（= tauri.conf.json 的 `productName` = `iJipu`）
 *      生成 `iJipu.lnk`，且**不写「备注」**。**不能**靠改 `productName` 来改名——它同时决定安装目录
 *      （`$LOCALAPPDATA\<productName>`）与"卸载"注册表键，一改老用户会被装到新目录、旧目录残留。
 *      故改为在钩子里把 .lnk **重建**成中文名 + 备注：
 *        · 为什么必须"重建"：Windows 快捷方式的「备注」只在 `CreateShortCut` 的第 7 个参数写一次，
 *          事后用纯 NSIS 改不了（要写 COM 的 IPropertyStore）。
 *        · 重建后必须补 `SetLnkAppUserModelId`，否则任务栏会把新快捷方式当成另一个应用（图标分裂两份）。
 *   ② 右键"打开方式"里的动词：模板把 COMMANDTEXT 硬编码成 `Open with iJipu`（配置文件改不了），
 *      这里在模板写完注册表后覆写成中文。
 *
 * ⚠️ 本文件含**中文字符串常量**，必须保存成**带 BOM 的 UTF-8**：makensis 对无 BOM 文件按 ANSI
 *    解析，中文会变成乱码（`installer.nsi` / `utils.nsh` 都是带 BOM 的）。
 *
 * 安装模式是 currentUser（tauri.conf.json 未设 installMode ⇒ 默认 currentUser），
 * 因此关联写在 HKCU；这里显式写 HKCU 而不是 SHCTX，避免与卸载器里的 SetShellVarContext 时序耦合。
 */
!define IJIPU_JPS_EXT "jps"
!define IJIPU_PROGID "iJipu.jps"
; adj1315（用户 2026-11-18）：`.jps` 文件的**类型图标**不再是应用图标。
; 用户口径：「jps 文件的关联图标用 Logo.png（通用 123 标记），应用图标用各自的 Logo-xx.png」。
; 为什么不能只改 `bundle.icon`：那份图标同时是 exe 图标、安装包图标、快捷方式图标，
; 换它等于把应用图标也换掉。文件类型图标另有其位 —— ProgID 的 `DefaultIcon`。
; 模板（installer.nsi:652）写的是 `DefaultIcon = $INSTDIR\ijipu.exe,0`，等于"用应用图标当文件图标"；
; 本宏在第 712 行**之后**执行，所以这里覆写就是最终生效值。
; `jps.ico` 由 tauri.conf.json 的 `bundle.resources` 从 `icons/jps.ico` 拷到 `$INSTDIR\jps.ico`
; （源图 = 仓库根 `矢量图/Logo.png`，256/128/64/48/32/24/16 七档）。
!define IJIPU_JPS_ICON "jps.ico"
; 模板生成的主程序名与快捷方式名（对应 tauri.conf.json 的 productName / 打包出的 exe 名）
!define IJIPU_EXE "ijipu.exe"
!define IJIPU_LNK_OLD "iJipu.lnk"
; 用户指定的新快捷方式名与备注（samples 无关，纯品牌文案）
; ⚠️ 第一个字是**拉丁字母 i**（`i记谱`），不是「爱记谱」——这是用户明确指定的写法：
;   桌面上原本已有一个「爱记谱 iJipu.lnk」，那是 Chrome 装出来的**网页版(PWA)**快捷方式
;   （目标 = chrome_proxy.exe + `--app-id=…`）。若这里也用「爱记谱 iJipu」就会**同名覆盖**掉它，
;   故用户选了 `i记谱 iJipu` 与之区分，两个图标可以并存。
!define IJIPU_LNK_NEW "i记谱 iJipu.lnk"
!define IJIPU_LNK_DESC "爱记谱 - 码即成，谱自现，代码式简谱制谱引擎。"
!define IJIPU_OPEN_VERB "使用 iJipu 打开"
; 应用的 AppUserModelID（任务栏分组用），必须与 tauri.conf.json 的 `identifier` 一致（smoke 有断言兜底）
!define IJIPU_AUMI "com.ijipu.app"

/**
 * adj944（用户需求「全局设置里注册 iJipu CLI」）：卸载时把安装目录从**当前用户 PATH** 里摘掉。
 *
 * 放在这里（而不是整份逻辑写进本文件）：那是纯字符串活 + 几处注册表清理，单独一个文件
 * **可以拿 makensis 单独跑小测试**（本仓库的 Rust 单测在本机跑不起来，见 E-2026-427 ⇒
 * "能单独验证"这件事很值钱 ✓）。它用到 `${IJIPU_EXE}`，故**必须定义在下面这些常量之后**。
 *
 * ⚠ 路径拼接要自己补分隔符：`${__FILEDIR__}` **不带**末尾反斜杠（实测写成 `"${__FILEDIR__}cli-path.nsh"`
 *   会变成 `…\nsiscli-path.nsh`，makensis 报 "could not find" ✗）。
 */
!include "${__FILEDIR__}\cli-path.nsh"

/**
 * 给快捷方式写 AppUserModelID。
 *
 * 为什么不直接 `!insertmacro SetLnkAppUserModelId`（Tauri 模板 utils.nsh 里那个）：它的宏体里写的是
 * `${BUNDLEID}`，而 `BUNDLEID` 要到 `installer.nsi` 第 49 行才 `!define`，本文件在第 31 行就被
 * `!include` 了 ⇒ 宏展开时它是未定义符号。实测后果是 makensis 告警
 * `warning 6000: unknown variable/constant "{BUNDLEID}"`，并把**字面量 `{BUNDLEID}`** 当成 AUMI 写进
 * .lnk ⇒ 任务栏会把快捷方式当成另一个应用（图标分裂，正是重建快捷方式最怕的副作用）。
 * 也不能在本文件里抢先定义 `BUNDLEID`：NSIS 里 `!define` 重复定义是**编译错误**（实测
 * `!define: "X" already defined!`），不是覆盖。
 * 故自备一份等价宏，把 AUMI 作为参数传入。用到的常量都来自本文件之前 `!include` 的
 * `Win\COM.nsh` / `Win\Propkey.nsh`（第 25-26 行），可正常展开。
 *
 * ⚠️ 副作用（照抄模板宏，必须让调用者看见）：本宏用 `r0`–`r5` 做草稿 ⇒ **`$0`–`$5` 全部被写坏**。
 *    调用前后不要指望这几个寄存器里的值还在（E-2026-240：探针里把目标路径放 `$0`、两次 `CreateShortcut`
 *    中间插了一次本宏调用 ⇒ 第二个快捷方式的目标被写成垃圾值）。
 */
!macro IJIPU_SET_AUMI shortcut aumi
  !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r0 ""
  ${If} $0 P<> 0
    ${IUnknown::QueryInterface} $0 '("${IID_IPersistFile}",.r1)'
    ${If} $1 P<> 0
      ${IPersistFile::Load} $1 '("${shortcut}", ${STGM_READWRITE})'
      ${IUnknown::QueryInterface} $0 '("${IID_IPropertyStore}",.r2)'
      ${If} $2 P<> 0
        System::Call 'Oleaut32::SysAllocString(w "${aumi}") i.r3'
        System::Call '*${SYSSTRUCT_PROPERTYKEY}(${PKEY_AppUserModel_ID})p.r4'
        System::Call '*${SYSSTRUCT_PROPVARIANT}(${VT_BSTR},,&i4 $3)p.r5'
        ${IPropertyStore::SetValue} $2 '($4,$5)'

        System::Call 'Oleaut32::SysFreeString($3)'
        System::Free $4
        System::Free $5
        ${IPropertyStore::Commit} $2 ""
        ${IUnknown::Release} $2 ""
        ${IPersistFile::Save} $1 '("${shortcut}",1)'
      ${EndIf}
      ${IUnknown::Release} $1 ""
    ${EndIf}
    ${IUnknown::Release} $0 ""
  ${EndIf}
!macroend

/** 通知资源管理器：文件关联变了，请刷新缓存（= SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_FLUSH)） */
!macro IJIPU_NOTIFY_SHELL
  System::Call "shell32::SHChangeNotify(i, i, i, i) (0x08000000, 0x1000, 0, 0)"
!macroend

/**
 * 把模板生成的英文快捷方式迁移成「i记谱 iJipu」并补上备注（**幂等**，可重复调用）。
 *
 * 需要两个调用时机（缺一不可）：
 *   1. `NSIS_HOOK_POSTINSTALL`：静默/被动安装时模板已在此前建好桌面快捷方式；
 *      开始菜单快捷方式更是无条件在 `Section Install` 里建的，只有这里能改。
 *   2. `.onGUIEnd`：GUI 安装的**桌面**快捷方式是完成页勾选后才创建的
 *      （模板 `MUI_FINISHPAGE_SHOWREADME_FUNCTION`），那时 POSTINSTALL 早已跑完。
 *
 * 只在「旧名 .lnk 确实存在」且「主程序确实已就位」时动手：
 *   - 前一条保证用户取消勾选「创建桌面快捷方式」时我们什么都不做（尊重用户选择）；
 *   - 后一条保证安装被中途取消时不会去改写上一版留下的旧快捷方式。
 *
 * `$SMPROGRAMS` 下按**平铺**路径处理：本工程 `nsis.startMenuFolder` 未设 ⇒ 模板生成的
 * `STARTMENUFOLDER` 为空，走的是 `$SMPROGRAMS\<name>.lnk` 分支。若将来配置了开始菜单文件夹，
 * 这里要跟着改成 `$SMPROGRAMS\$AppStartMenuFolder\<name>.lnk`。
 */
Function IJIPU_FixShortcuts
  IfFileExists "$INSTDIR\${IJIPU_EXE}" 0 ijipu_fix_return

  IfFileExists "$DESKTOP\${IJIPU_LNK_OLD}" 0 ijipu_fix_startmenu
    ; 第 7 个参数就是「备注」；中间的图标/显示方式是**位置参数**，必须原样补齐。
    ; 显示方式只能写符号名 `SW_SHOWNORMAL`：实测写数字 `1` 会被 makensis 拒绝
    ; （`CreateShortcut: unknown show mode "1"`，见 docs/ERRORS-LOG.md E-2026-239）。
    Delete "$DESKTOP\${IJIPU_LNK_NEW}"
    CreateShortcut "$DESKTOP\${IJIPU_LNK_NEW}" "$INSTDIR\${IJIPU_EXE}" "" "$INSTDIR\${IJIPU_EXE}" 0 SW_SHOWNORMAL "" "${IJIPU_LNK_DESC}"
    !insertmacro IJIPU_SET_AUMI "$DESKTOP\${IJIPU_LNK_NEW}" "${IJIPU_AUMI}"
    ; 删旧名前先摘掉可能存在的固定项（开始菜单/任务栏）：改名后旧 pin 必然失效，
    ; 主动摘掉比留一个点不开的幽灵图标好（模板在卸载时也是这么做的）。
    !insertmacro UnpinShortcut "$DESKTOP\${IJIPU_LNK_OLD}"
    Delete "$DESKTOP\${IJIPU_LNK_OLD}"

  ijipu_fix_startmenu:
  IfFileExists "$SMPROGRAMS\${IJIPU_LNK_OLD}" 0 ijipu_fix_return
    Delete "$SMPROGRAMS\${IJIPU_LNK_NEW}"
    CreateShortcut "$SMPROGRAMS\${IJIPU_LNK_NEW}" "$INSTDIR\${IJIPU_EXE}" "" "$INSTDIR\${IJIPU_EXE}" 0 SW_SHOWNORMAL "" "${IJIPU_LNK_DESC}"
    !insertmacro IJIPU_SET_AUMI "$SMPROGRAMS\${IJIPU_LNK_NEW}" "${IJIPU_AUMI}"
    !insertmacro UnpinShortcut "$SMPROGRAMS\${IJIPU_LNK_OLD}"
    Delete "$SMPROGRAMS\${IJIPU_LNK_OLD}"

  ijipu_fix_return:
FunctionEnd

; GUI 安装：完成页勾选后才会建桌面快捷方式，故必须在安装器退出前再修一次。
; （静默模式同样会走到这里，重复调用无害——函数幂等；`.onGUIEnd` 目前模板/NSIS 内置库都没占用）
Function .onGUIEnd
  Call IJIPU_FixShortcuts
FunctionEnd

/**
 * 安装后：把 ProgID 登记进 `.jps\OpenWithProgids`（值名=ProgID、数据为空串，Microsoft 口径），
 * 并通知资源管理器刷新，让"双击即用 iJipu 打开"与右键菜单**立刻**生效。
 */
!macro NSIS_HOOK_POSTINSTALL
  ; ① 右键"打开方式"的动词文案：模板写的是英文 `Open with iJipu`，覆写成中文
  WriteRegStr HKCU "Software\Classes\${IJIPU_PROGID}\shell\open" "" "${IJIPU_OPEN_VERB}"
  ; ①b adj1315：`.jps` 的类型图标用通用 Logo（不是应用图标）。模板写的是 `…\ijipu.exe,0`。
  ;     `IfFileExists` 兜底：万一资源没装进安装目录，宁可留着模板写的 exe 图标，也不要留一个指向
  ;     不存在文件的 DefaultIcon（那会让资源管理器显示成空白文件图标，比"图标不对"更难解释）。
  IfFileExists "$INSTDIR\${IJIPU_JPS_ICON}" 0 ijipu_jps_icon_done
    WriteRegStr HKCU "Software\Classes\${IJIPU_PROGID}\DefaultIcon" "" "$INSTDIR\${IJIPU_JPS_ICON},0"
  ijipu_jps_icon_done:
  ; ② 登记进「打开方式」列表
  WriteRegStr HKCU "Software\Classes\.${IJIPU_JPS_EXT}\OpenWithProgids" "${IJIPU_PROGID}" ""
  ; ③ 快捷方式中文名 + 备注
  Call IJIPU_FixShortcuts
  !insertmacro IJIPU_NOTIFY_SHELL
  ; ④ adj1082：资源包靠这个值找主程序目录；「应用和功能」里只改显示名，不动 productName。
  WriteRegStr HKCU "Software\iJipu" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}" "DisplayName" "爱记谱 iJipu"
!macroend

/**
 * 卸载前：删掉我们改过名的快捷方式。
 * 模板的删除逻辑只认 `${PRODUCTNAME}.lnk`（= `iJipu.lnk`），不认中文名，不补删就会在卸载后
 * 留下打不开的死图标。**必须**和模板一样受 `$UpdateMode` 保护：更新流程会先跑一次卸载器，
 * 那时删掉用户的快捷方式、而更新路径又不会重建，用户就凭空少了一个桌面图标。
 * 按名删除、不做目标校验：名字是我们自己起的；校验目标反而会在用户手工改过目标时漏删。
 */
!macro NSIS_HOOK_PREUNINSTALL
  ; adj1082：卸载二选一（完全卸载 / 保留音色库与资源包），默认保留。
  ; 更新（$UpdateMode=1）与静默卸载（/S）不弹窗，默认保留；静默清空要走「完全卸载」请手动删目录。
  ${If} $UpdateMode <> 1
    IfSilent ijipu_keep_assets
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "要完全卸载吗？$\r$\n$\r$\n是：同时删除音色库、资源包、本机配置（主题 / 卡片 / 草稿）和浏览器缓存。$\r$\n否：只删程序，以上全部保留（下次安装可直接复用）。" IDYES ijipu_full_uninstall IDNO ijipu_keep_assets
    ijipu_full_uninstall:
      ; ① 旧版「一个资源包装多个音色」的卸载器（兼容）
      ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\iJipuAssets" "UninstallString"
      StrCmp $0 "" ijipu_asset_legacy_done
      ExecWait '"$0" /S'
      ijipu_asset_legacy_done:
      ; ② 新版：每个资源文件一个卸载器，登记在 ResourceUninstallers（值名 = 资源 id）。
      ;    逐个调用后删登记；卸载器自己也会删，但主卸载器先删可保证枚举不跳项。
      ijipu_res_loop:
        EnumRegValue $R1 HKCU "Software\iJipu\ResourceUninstallers" 0
        StrCmp $R1 "" ijipu_res_done
        ReadRegStr $R2 HKCU "Software\iJipu\ResourceUninstallers" "$R1"
        DeleteRegValue HKCU "Software\iJipu\ResourceUninstallers" "$R1"
        StrCmp $R2 "" ijipu_res_loop
        IfFileExists "$R2" 0 ijipu_res_loop
        ExecWait '"$R2" /S'
        Goto ijipu_res_loop
      ijipu_res_done:
      DeleteRegKey HKCU "Software\iJipu\ResourceUninstallers"
      ; ③ 按目录兜底（含旧版随包的那份 generaluser_gs.sf2，它已不在新卸载清单里）。
      RMDir /r "$INSTDIR\soundfonts"
      RMDir /r "$INSTDIR\tools"
      ; adj1085：本机配置（%APPDATA%\iJipu）与 WebView2 的浏览器存储（旧配置/缓存）。
      ; 只在「完全卸载」分支删；选「否」或静默卸载默认保留。
      RMDir /r "$APPDATA\iJipu"
      RMDir /r "$LOCALAPPDATA\${IJIPU_AUMI}"
      Goto ijipu_assets_done
    ijipu_keep_assets:
      FileOpen $0 "$INSTDIR\keep.flag" w
      FileWrite $0 "iJipu 按用户选择保留了音色库/资源包。$\r$\n下次安装会直接复用；要彻底删除请重新运行卸载并选「完全卸载」。$\r$\n"
      FileClose $0
    ijipu_assets_done:
  ${EndIf}
  ${If} $UpdateMode <> 1
    !insertmacro UnpinShortcut "$DESKTOP\${IJIPU_LNK_NEW}"
    Delete "$DESKTOP\${IJIPU_LNK_NEW}"
    !insertmacro UnpinShortcut "$SMPROGRAMS\${IJIPU_LNK_NEW}"
    Delete "$SMPROGRAMS\${IJIPU_LNK_NEW}"
  ${EndIf}
!macroend

/**
 * 卸载后（此时 `APP_UNASSOCIATE` 已跑完：`.jps` 默认值已还原、我方 ProgID 键已删）：
 * 清掉我们留下的备份值与 OpenWithProgids 条目，并在键确实为空时把键也删掉。
 */
!macro NSIS_HOOK_POSTUNINSTALL
  ; ① 我方备份值（安装时写入的"原处理器"记录）——只删这一个值名，键留着给别人
  DeleteRegValue HKCU "Software\Classes\.${IJIPU_JPS_EXT}" "${IJIPU_PROGID}_backup"
  ; ② 我方在「打开方式」列表里的条目
  DeleteRegValue HKCU "Software\Classes\.${IJIPU_JPS_EXT}\OpenWithProgids" "${IJIPU_PROGID}"
  ; ③ `OpenWithProgids` 子键：只有它确实没有任何值（别的程序也没登记）时才删
  ;    说明：该子键下所有值名都是非空的 ProgID，故 `EnumRegValue ... 0` 返回空串即可判定"没有值"
  EnumRegValue $R8 HKCU "Software\Classes\.${IJIPU_JPS_EXT}\OpenWithProgids" 0
  StrCmp $R8 "" 0 ijipu_uninstall_jps_ext
  DeleteRegKey HKCU "Software\Classes\.${IJIPU_JPS_EXT}\OpenWithProgids"

  ijipu_uninstall_jps_ext:
  ; ④ `.jps` 键：仅当"默认值为空（已无默认处理器）+ 除默认值外没有任何值 + 没有任何子键"时才删
  ReadRegStr $R9 HKCU "Software\Classes\.${IJIPU_JPS_EXT}" ""
  StrCmp $R9 "" 0 ijipu_uninstall_done
  EnumRegValue $R9 HKCU "Software\Classes\.${IJIPU_JPS_EXT}" 1
  StrCmp $R9 "" 0 ijipu_uninstall_done
  EnumRegKey $R9 HKCU "Software\Classes\.${IJIPU_JPS_EXT}" 0
  StrCmp $R9 "" 0 ijipu_uninstall_done
  DeleteRegKey HKCU "Software\Classes\.${IJIPU_JPS_EXT}"

  ijipu_uninstall_done:
  /**
   * adj944：**把安装目录从当前用户 PATH 里摘掉**（用户需求："卸载会自动解除"）。
   *
   * 为什么整段受 `$UpdateMode` 保护：更新流程会先跑一次卸载器 —— 那时把 PATH 摘了、
   * 而更新路径不会重新注册，用户就"更新一次丢一次注册" ✗（与上面删快捷方式同一条理由）。
   * 本宏**幂等**：PATH 里没有我们那条 ⇒ 连注册表都不写一个字 ✓（见 `cli-path.nsh`）。
   */
  ${If} $UpdateMode <> 1
    !insertmacro IJIPU_PATH_UNREGISTER
  ${EndIf}
  !insertmacro IJIPU_NOTIFY_SHELL
!macroend
