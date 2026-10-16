# dsh-file-menu — 交付文件右键菜单

在 DeepSeek Harness 的聊天界面里，**对着生成的文件卡片点右键**，直接打开、复制文件本体、复制路径、定位文件夹、另存为或下载 —— 不用先去点链接、也不用去资源管理器里找文件。

- 宿主半（Host）：`index.js`，注册三条鉴权路由 `api/dsh-file-menu.info` / `.act` / `.raw`
- 浏览器半（Client）：`client.js`，占用 `deliverables.file.actions`（触发按钮）与 `shell.overlay`（菜单浮层）
- **右键即开**：菜单在按下的那一帧就完整画出来，不等待任何网络请求

## 1. 菜单能做什么

| 菜单项 | 行为 | 依赖 |
| --- | --- | --- |
| 打开文件 | 用系统默认程序打开（.docx→Word、.zip→资源管理器/解压工具…） | Host 桌面可用 |
| 用其他应用打开… | 拉起系统自己的「打开方式」对话框（Windows：`rundll32 shell32.dll,OpenAs_RunDLL <文件>`），从中任选一个程序 | 同上 |
| 打开文件所在文件夹 | 资源管理器里定位并选中该文件 | 同上 |
| 复制文件 | **把文件本体**放进系统剪贴板（Windows 用 `Set-Clipboard`，macOS 用 osascript） | 同上 |
| 复制文件路径 | 复制完整本地路径 | 无 |
| 另存为… | 弹原生目录选择框，另存到指定文件夹 | 目录选择器插件 |
| 下载文件 | 浏览器下载，文件流式传输（不占内存） | 无 |
| 复制下载链接 | 复制该文件的下载 URL | 无 |
| 在新标签页中打开下载链接 | 新标签页直接下载 | 无 |

菜单项**不逐条列出具体应用**（不出现「用 Word 打开」「用 WPS 打开」这类行）：那需要宿主把系统注册的处理程序枚举出来，而这个枚举在 Windows 上对 `.docx` / `.xlsx` 会整体失败（见 [1.0](#10-为什么没有逐条列出具体应用)）。取而代之的是**始终存在**的「用其他应用打开…」，它走系统自带的对话框，任何扩展名都可用。菜单行左侧带一个 16px 的线性图标；菜单表头只显示文件名与「大小 · 目录」，不带扩展名方块。

降级链是自动的：没有桌面（纯网页 / 远程）时「打开/复制文件/定位文件夹」显示为不可用并给出说明；「复制文件」在宿主剪贴板失败时自动退化为浏览器剪贴板（图片/文本类），再失败就退化为复制路径；「另存为」没有原生选择器时退化为浏览器下载。常见类型 `.docx/.xlsx/.pdf/.exe/.zip/.rar` 全部按文件本体处理，不做类型白名单。

### 1.0 为什么没有逐条列出具体应用

最早的设计是让宿主枚举「这个扩展名当前有哪些处理程序」，每个程序渲染成一行。实测发现这条路在 Windows 上不可靠：`SHAssocEnumHandlers` 枚举出的第一个 handler，在 `.docx` / `.xlsx` 上调用 `GetName` 会抛 `E_FAIL`（COM 层报 `Error HRESULT E_FAIL has been returned from a call to a COM component.`），而官方实现没有做单条容错，于是整次枚举抛出、列表变空。本机实测：

| 扩展名 | 枚举结果 |
| --- | --- |
| `.zip` | 正常，8 条（Bandizip / WPS 解压 / 资源管理器 / 记事本 / 百度网盘 / QQ / Word / WMP） |
| `.pdf` | 正常，10 条（Edge / WPS PDF / …） |
| `.txt` | 正常，7 条 |
| `.docx` | **失败**（E_FAIL） |
| `.xlsx` | **失败**（E_FAIL） |

这不是本插件的 bug，也不是打开功能坏了 —— 默认程序查询（`AssocQueryString`）本身是好的，「打开文件」照常调用 Word。但一个「有时有、有时没有」的应用列表对用户没有价值，所以本插件**彻底去掉了逐应用行**，只保留一行「用其他应用打开…」：

- 它调用 `rundll32.exe shell32.dll,OpenAs_RunDLL <文件>`，拉起的就是资源管理器右键菜单里那个「打开方式」对话框；
- 走的是另一条 Shell 代码路径，**不受上面那个 E_FAIL 影响**，所以 `.docx` / `.xlsx` / `.zip` / `.pdf` 全部一样可用；
- 对话框里列出的程序由系统自己决定，比插件枚举的任何列表都更准。

宿主半因此也从四条路由减到三条：那个只为应用列表服务的 `/api/dsh-file-menu.apps` 路由已删除。

### 1.1 为什么右键是「秒开」

菜单里每一项都只靠 `sessionId + seq + index` 三元坐标驱动，**没有任何一项需要先知道文件名**。所以菜单在右键那一帧就把全部项目画出来并落在鼠标位置，元数据只是随后把表头（文件名 / 大小 / 目录）补上：

| 环节 | 做法 |
| --- | --- |
| 首帧 | 乐观渲染全部菜单项 + 用估算尺寸同步落位，不显示任何「正在读取…」占位 |
| 表头占位 | 表头位置**预先留好高度**（两条占位色块），名字到达时原地填入，菜单高度不变、内容不下跳 |
| 元数据 | `api/dsh-file-menu.info` 独立请求，到达后只精修表头 |
| 预取 | 卡片**滚入视野**或**鼠标划过**时，就在浏览器空闲时提前读它的表头（并发上限 2，同一卡片只读一次） |
| 缓存 | `info` 路由有一层客户端缓存（按坐标），重复右键同一张卡片**零请求** |
| 无慢探测 | 菜单不再依赖任何可能耗时数十秒的系统查询，首帧即终态 |

预取让「第一次右键」也拿到完整表头：卡片在屏幕上时它的元数据往往已经读好了，右键那一帧表头就是填满的。若某张卡片还没来得及预取（例如刚滚入就立刻右键），菜单仍会立刻完整出现，表头先是两道占位色块、随后原地补上名字 —— 因为位置已预留，观感是「渐显」而不是「往下跳」。预取失败不会被记录，也不会打扰用户；真正右键时若读不到，菜单照常报错。

历史背景：Windows 上枚举关联应用需要全量扫描注册表（本机实测 `reg.exe query HKLM\SOFTWARE\Classes /s` 约 **88 秒**）。改造前它挡在 info 的响应里，右键后菜单要等它；后来拆成独立路由；现在连同那条路由一起去掉了。

## 2. 安装

插件目录：`E:\文档\deepseek-harness\default-workspace\dsh-file-menu`

```
plugin_manager(action: "install_bundle",
               target: "E:\\文档\\deepseek-harness\\default-workspace\\dsh-file-menu")
```

首次安装**无需重启**：装完 `include:dsh-file-menu` 即为 `active`。

但**之后修改 `index.js`（宿主半）需要重启 DeepSeek Harness 进程才生效**。原因是插件的宿主半由 Node 的 ESM `loadCache` 按 URL 缓存，而本 profile 的 `hmr` 配的是 `root: []`（不监听任何模块文件），所以文件改动不会触发缓存清理 —— 用 Plugin Manager 的 enable/disable 循环也只重建 entry，拿到的仍是旧的 `index.js` 命名空间。`client.js`（浏览器半）不受此限，刷新页面即可。

> 已装一份、只想改客户端样式或菜单文案 → 改 `client.js` 后按 `F5`。
> 改的是路由、动作或任何 `index.js` 逻辑 → 退出并重新打开 DeepSeek Harness。

手工等价做法：把包链接进当前 profile 的 `node_modules`，并在 profile 的 `package.json` 里登记。

```powershell
$profile = "C:\Users\ASUS\.dsh\profiles\desktop"
pnpm --dir $profile add "link:E:\文档\deepseek-harness\default-workspace\dsh-file-menu"
# 然后把 "dsh-file-menu" 追加到 profile package.json 的 dsh.profile.bundles 数组
```

验证安装：

- `plugin_manager(action:"list_plugins")` 里有 `include:dsh-file-menu`，状态 `enabled` + `fiberPhase: "active"`
- 右侧栏 → 插件管理里能看到「文件右键菜单」
- 打开任意带交付文件卡片的会话，卡片操作行里多出一个 `⋯` 按钮

卸载：

```powershell
plugin_manager(action: "remove_bundle", target: "dsh-file-menu")
```

### 从 GitHub 安装

源码已发布在 <https://github.com/lemon0-00/dsh-file-menu>。除了上面的本地 `link:` 方式，也可以直接按仓库安装：

```powershell
# 方式一：交给 dsh CLI（会把仓库检出到 profile）
dsh plugin --profile desktop add github:lemon0-00/dsh-file-menu

# 方式二：用 Plugin Manager 按安装规格装入
plugin_manager(action: "install_bundle",
               target: "github:lemon0-00/dsh-file-menu")
```

从仓库安装的是**快照**（市场/CLI 会记录 commit），此后改动不会自动跟随；要边改边试就用本节的 `link:` 方式。

## 3. 使用

1. 让 dsh 生成或发给你一个文件（用 `present` 产出的交付卡片，或任何带文件卡片的回复）。
2. 在这张卡片上**任意位置点右键**（卡片缩略图、文件名、空白处都行），或者点操作行里的 `⋯` 按钮。
3. 在弹出菜单里选一项，例如「打开文件」。
4. 反馈会以短提示条的形式出现在菜单底部（「已打开」「已复制」「已复制路径」…），失败则给出具体原因。

快捷键与交互：`Esc` 关闭菜单；点击菜单外任意位置关闭；滚动或改变窗口大小自动关闭；菜单贴边时自动向内收，不会跑出屏幕。

## 4. 结构

```
dsh-file-menu/
├── package.json         # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml     # 把 index.js 作为 Host 半插入
├── index.js             # Host 半：3 条鉴权路由、坐标校验、桌面动作、系统「打开方式」对话框
├── client.js            # 浏览器半：触发按钮、右键绑定、菜单浮层、样式
├── icon.svg
├── LICENSE
├── locale/zh.json
├── locale/en.json
└── README.md
```

### 关于 `repository` 字段（身份，不是装饰）

`package.json` 里的 `repository` 指向 <https://github.com/lemon0-00/dsh-file-menu>，这个字段有实际作用：插件市场用它判断「本地这个 `link:` 安装对应目录里的哪一条插件」。

没有它时，市场只能按**名字**猜——凡是同名条目，就点亮「✓ 已安装」，并出现「换用线上版本」按钮。目录里恰好有一个第三方同名插件 `dsh-file-menu`（作者 dreammaker2016，npm 名 `@z1995418/dsh-file-menu`，见 <https://github.com/dreammaker2016/dsh-file-menu>），于是本插件曾被误认成它。

有了 `repository` 之后，市场走**强身份**分支：拿本仓库 `owner/repo` 去比对目录条目，匹配不上就明确判定 `repo-mismatch`（"精选目录里有同名插件，但与你本地仓库不一致，无法安全恢复"），不再按下那个按钮就装进别人的包。可用 `_check/identity-check.mjs` 与 `_check/market-view-check.mjs` 复现这条判定。

### 安全模型

客户端**不被信任**：`/api/dsh-file-menu.*` 只接受 `sessionId + seq + index` 三元坐标，宿主侧再走一遍官方同款校验链 —— `sessionQuery.readEvent` 取出该会话事件里 `deliverables/presented` 的 `data.files[index].path`，再用 `workspaceFiles.stat` 求绝对路径，最后用 `fs.processPathFromHostPath` + `fs.resolve` 反查确认映射回原路径，任何一步不过就 404/422。客户端无法自造任意路径来读写磁盘。

## 5. 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| 卡片上右键没反应 | 该卡片不是交付卡片（例如对话正文里的行内文件链接，本插件故意不接管，见下）。确认插件为 active。 |
| 「打开文件」是灰的 | 宿主桌面不可用（纯网页端/远程）。改用「复制文件路径」「下载文件」「复制下载链接」。 |
| 看不到「用 Word 打开」这类行 | 设计如此，见 [1.0](#10-为什么没有逐条列出具体应用)。请用**「用其他应用打开…」**，它在对话框里列出系统认定可用的程序。 |
| 「用其他应用打开…」没弹出对话框 | 仅 Windows 支持（走 `rundll32 shell32.dll,OpenAs_RunDLL`），且需要 Host 桌面可用；纯网页端会返回 409。 |
| 「复制文件」提示只能复制路径 | 非 Windows/macOS，或宿主剪贴板命令被策略拦截。路径已复制，可直接粘贴。 |
| 「另存为」变成下载 | 未安装原生目录选择器插件（`@deepseek-ai/dsh-host-directory-picker-auto`）。 |
| 菜单样式错乱 | 与本机主题 token 冲突；本插件只用 `--dsw-alias-*` 变量并全部收敛在 `.dfm-*` 前缀下，不覆盖任何全局样式。 |
| 表头先显示两道灰色占位条 | 该卡片还没预取到（刚滚入就右键）。位置已预留，名字会原地填入、不跳版；稍等即可，之后再右键这张卡就是瞬时完整的。 |
| 改了 `index.js` 但行为没变 | 见[第 2 节](#2-安装)：宿主半改动必须重启 DeepSeek Harness 进程。 |

## 6. 已知边界

- **不接管对话正文里的行内文件链接。** 那些链接由官方 `primitives` 渲染成没有 `href`、没有 `data-*` 的按钮，接管它们必须靠哈希类名或 `title` 去猜别人的 DOM，违反插件规范，也会随官方版本抖动。验收要求的交付卡片路径已完整覆盖。
- **不逐条列出具体应用。** 原因见 [1.0](#10-为什么没有逐条列出具体应用)：宿主枚举在 `.docx` / `.xlsx` 上会整体失败，一个时有时无的列表不如系统的「打开方式」对话框可靠。
- 变更对比页（`deliverables.review.file.actions`）传的也是同一种 `sessionId+seq+index` 坐标，属于后续可选扩展。
- **与第三方同名插件的关系**：目录里另有一个 `dsh-file-menu`（作者 dreammaker2016，npm 名 `@z1995418/dsh-file-menu`）。二者**不冲突**——loader entry id 不同（本插件 `dsh-file-menu`，对方 `file-menu`），且本插件已声明 `repository`，市场不会再把它认成对方。两者的取舍差异：对方是**全 UI 通用右键菜单**（文字、输入框、超链接、行内文件引用，接受任意绝对路径），本插件**只接管交付文件卡片**（见[第 1 节](#1-菜单能做什么)），坐标由宿主反查校验，并额外提供「复制文件本体」「另存为」「流式下载」。
