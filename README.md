# DSH Opening Splash

为 DeepSeek Harness 页面添加启动开场动画的 DSH bundle 插件。动画在独立 iframe 中播放，默认约 20.25 秒，结束后淡出进入主界面；默认可按 Esc 跳过，单击和双击均不会跳过。开启设置中的「双击跳过」后，可从双击位置以两圈水波过渡进入 Harness 界面。

插件使用 Node.js 内置模块，没有运行时依赖。支持浏览器页面和官方 Electron 桌面端的两种 index 注入通道。

从 1.0.2 起，动画中的 `ID CONFIRMED : DEEPSEEK` 支持自动显示 DSH 的登录账号名称，详见下方“账号名称”。

插件还会在「设置」面板左侧导航中注册一个自己的选项卡，提供双击跳过（含双击处的水波涟漪过渡）、恢复默认名字，以及一个尚未实现的“自定义开屏动画”占位项，详见下方“设置选项卡”。

## 安装

需要 Node.js 20 或更新版本，以及支持 DSH bundle、`webServer` 和 index 注入接口的 DeepSeek Harness。账号名称功能还需要客户端模块系统、`remote.account` 和 `locale` 服务。此前在桌面端 0.2.0-rc.2 确认过播放；1.0.3 通过离线回归测试，尚未验证此次修改的实际桌面端画面。

在 DeepSeek Harness 的插件市场中选择 npm 官方源或中国大陆镜像源，输入 `dsh-opening-splash` 即可安装。已安装用户请更新到 1.0.3，然后重启 DSH。

从 npm 安装到 Windows 桌面 profile：

```powershell
dsh plugin --profile desktop add dsh-opening-splash
```

镜像尚未同步时，可直接从 npm 官方 tarball 安装 1.0.3：

```powershell
dsh plugin --profile desktop add https://registry.npmjs.org/dsh-opening-splash/-/dsh-opening-splash-1.0.3.tgz
```

直装地址：[dsh-opening-splash-1.0.3.tgz](https://registry.npmjs.org/dsh-opening-splash/-/dsh-opening-splash-1.0.3.tgz)。

离线或开发时，下载或克隆仓库后，将插件目录安装到实际使用的 profile：

```powershell
dsh plugin --profile desktop add link:D:\path\to\dsh-opening-splash
dsh plugin --profile desktop list
```

安装后重启 DeepSeek Harness 并刷新页面。本地路径必须指向含 `package.json` 的插件目录。其他 profile 请替换 `desktop`。

## 账号名称

插件通过已认证的客户端 `ctx.remote.account.getProfile()` 获取资料，仅替换 `ID CONFIRMED` 后的身份文字，DeepSeek 品牌标识保持原样。

| 账号情况 | 显示文字 |
|---|---|
| 已登录且有资料名 | `ID CONFIRMED : <name>` |
| 资料名为 `null`，有联系方式 | `ID CONFIRMED : <脱敏 contact>` |
| 已登录，但资料查询失败或名称与联系方式均为 `null` | 中文“已登录”或英文 `Signed in` |
| 未登录、仅使用 API Key、账号服务尚未就绪或资料结果为 `null` | `ID CONFIRMED : DEEPSEEK` |

账号状态流会清除切换账号后的旧资料；退出登录和会话过期也会清除旧名称，迟到的查询响应不会恢复旧名称。查询异步进行，不延迟动画播放，因此资料返回过晚时，本次动画仍可能显示默认文字。

用户名作为普通文字传给动画 iframe，不写入 URL、诊断上报或公开资源响应。支持中文并保留名称大小写；控制字符会转换为空格，最多显示 80 个 Unicode 码点，长文字会横向缩放以适应画面。没有新增自定义称呼配置项。

**恢复默认名字**（设置页开关，默认关）开启后不再向动画传递任何名字，`ID CONFIRMED` 后固定显示动画自带的 `DEEPSEEK`：开关打开时正在播放的页面会立即撤回已发布的名称，迟到的资料结果也不会再写回。切换开关时同一个开关处于开的状态下账号名只留在客户端内存中，不会进入动画文档。

该接入参照桌面端 0.2.0-rc.2 的客户端注册与 RPC 协议。离线测试覆盖名称降级、账号切换与过期清理、迟到响应、消息来源和令牌校验；DOM 桩测试不能替代实际桌面端视觉验收。

## 设置选项卡

插件在 DSH 的「设置」模态里注册一个选项卡，位置就是设置面板左侧那列导航（`settings.section` 槽位）。侧栏底部「设置」按钮打开面板后，左栏最下方会出现「开场动画」一项，点开是本插件自己的页面。导航文字跟随界面语言（中文「开场动画」／英文 `Opening splash`）。

页面上目前有三个条目：

| 条目 | 默认 | 作用 |
|---|---|---|
| **双击跳过** | 关 | 在画面上任意位置双击即结束开场，并在双击处用水波涟漪过渡到界面 |
| **恢复默认名字** | 关 | `ID CONFIRMED` 后显示 `DEEPSEEK`，而非当前登录账号名 |
| **使用自定义开屏动画** | 关 | 占位项，尚未实现：选择器为禁用状态，标注「尚未开放」 |

### 开关存在哪里

三个开关存在浏览器 `localStorage` 的 `dsh-opening-splash:settings` 键下，由浏览器端两半共用：设置页写入，动画加载器在每次播放前读取并与部署配置合并。因此它们是**本机浏览器的偏好**，不是部署配置——换一台机器或清空站点数据即回到默认；部署方在 `cordis.patch.yml` 里设的值仍然是基线。

- 打开设置页所在页面即可生效：写入后立即调 `window.DSHOpening.setPrefs()` 推给运行中的加载器，「恢复默认名字」无需刷新即可看到效果。
- 存储被禁用时开关只在当前页面有效，并会打印一次失败而不中断播放。
- 读取到的非布尔值（例如手写成 `"yes"`）会被忽略并回落到配置值。

### 双击跳过的过渡动画

双击位置决定两圈涟漪的圆心：外圈先扩散，内圈延后 180 毫秒扩散。Harness 界面沿内圈半径逐帧显现，直到覆盖最远的视口角落。两圈使用更清晰的蓝白描边与柔光，并放在独立图层，避免被显现界面的遮罩裁掉。

过渡从鼠标双击位置以零半径开始，柔边也从零宽度逐渐展开，避免起始时突然出现一大片透明区域。期间原开场动画继续播放，尚未被涟漪揭开的区域保留原动画画面，不会主动切成黑底；遮罩覆盖整个视口、开场画面完全消失时立即移除动画 iframe，停止播放，涟漪层随后清理。若开场在此期间自然播放到结尾，仍遵循它自身的收尾动画。

波纹的半径、透明度和边缘起伏共用遮罩的逐帧时钟。两圈绘制为带有亮色波峰、蓝色波谷和细亮边的水波带，边缘随时间波动，扩散过程中渐隐；外圈保持较高对比度，并靠近内圈，避免过早扩出视口。使用单个视口大小的 Canvas，像素倍率最高为 1.5，避免巨大阴影图层；Canvas 不可用时退回边缘起伏的 CSS 圈。

遮罩半径由 `requestAnimationFrame` 逐帧更新，不依赖浏览器对渐变 `mask-image` 的 CSS 插值；扩散先加速再减速。1.0.3 包含设置选项卡、双击水波跳过、恢复默认名字开关、过渡时序修复和动画性能优化。

遮罩由两个**像素半径**描述：第一个是透明区（孔）的半径，第二个是黑色起点，两者同时外移，黑色起点只比透明半径多出一段很短的柔边。因此每一帧两个停止点都保持顺序，不会出现“透明停止点跑到黑色之后”导致遮罩失效的情况。

- 动画关键帧由插件在运行期注入 `document.head`，不依赖宿主页面样式。
- 涟漪扩散时长取 `rippleMs`（默认 1800 毫秒），两圈错开 180 毫秒；界面约在 1980 毫秒时完全显现，之后保留短暂清理缓冲。此时长独立于开场播放倍速 `speed`。
- 引擎不支持 `mask-image` 时自动退化为普通淡出，绝不出现“永远盖着”的情况；宿主可用 `rippleReveal: false` 主动关闭该过渡，此时双击仍可结束播放，只是走淡出。
- 跨源 iframe（桌面端）无法直接读取点击坐标，宿主在动画文档里追加的 bridge 会以 `how:"dblclick"` 上报，并附带坐标；父页面再叠加 iframe 自身的位置换算成页面坐标。坐标缺失时从视口中心展开。
- 关闭双击跳过时不注册 `dblclick` 监听（bridge 始终带监听器代码，但按开关决定是否挂载）。
- 结束通知与淡出路径一致：`dsh:opening-complete` 在两种结束方式下都会触发，且只触发一次。

### bridge 与父页面的分工

动画文档里的 bridge 由宿主在**响应时**生成，因此它只能看到部署配置。用户在设置页写的开关存在父页面的 `localStorage` 里，bridge 读不到——所以父页面在动画就绪时会把开关投影进 iframe：

- 父页面发送 `{type:'prefs'}` 消息（带本次播放的令牌），bridge 据此挂载或卸载手势监听器，无需刷新。
- bridge 只增删**自己**挂的监听器，部署若已按配置挂好，父页面重复下发不会产生第二个监听器。
- 双击只上报手势和坐标，不调用原动画的 `skip()`；父页面也保留原动画播放，等涟漪过渡结束再移除 iframe。原动画的完成通知不会重复结束此次过渡。
- 主开关 `skippable` 与两个手势设置彼此独立：`skippable:false` 时两个手势都不挂载；只开双击时单击仍然不做任何事。

### 与单次点击的关系

`skipOnClick`（单次点击跳过）与「双击跳过」可同时开启：此时单次点击会等待一个双击判定间隔（320 毫秒）再执行，若期间出现第二次点击则取消单次跳过，改走涟漪过渡。这段等待在父页面和 iframe 内各自成立——谁先看到这一按谁负责等待，重复上报由父页面丢弃。只开双击时，单击不做任何事。

### 实现要点

- 通过 `ctx.slots.inject('settings.section', …)` 注册，该调用是声明感知的，因此插件与设置面板的加载先后不影响结果；点击左侧导航时该槽位才渲染页面。
- 插件在 `package.json` 的 `dsh.client.inject` 中声明 `@deepseek-ai/dsh-client-ui-settings-general`（声明 `settings.section` 的包）和 `@deepseek-ai/dsh-client-ui-primitives`（提供开关控件）。二者缺失时只是不注册选项卡或退回原生复选框，弹窗、诊断路由和账号名称功能不受影响。
- 页面用 `require('react').createElement` 手工构造元素，因此 `lib/client.js` 仍是无需打包的单文件；React 不可用时页面渲染为空而不会报错。
- 选项卡没有自定义图标：DSH 用导航项 `id` 作图标键，未知 id 使用默认齿轮图标。

## 配置

默认配置位于 [cordis.patch.yml](cordis.patch.yml) 的 `config` 中，未列出的字段可自行添加。修改配置后重启宿主。表中标注「可由设置页覆盖」的字段是部署基线，用户开关会覆盖它。

| 字段 | 默认值 | 含义与范围 |
|---|---|---|
| `enabled` | `true` | 是否注入启动动画；关闭后诊断路由仍保留 |
| `speed` | `1` | 播放倍速，0.1–8 |
| `oncePerSession` | `false` | 使用 sessionStorage，在同一标签页会话中只播放一次 |
| `cooldownMs` | `0` | 使用 localStorage 控制播放间隔，0–2592000000 毫秒 |
| `skippable` | `true` | 是否允许通过键盘或点击跳过；显式 API 仍可结束播放 |
| `skipOnAnyKey` | `false` | 任意按键跳过，需开启 `skippable` |
| `skipOnClick` | `false` | 点击跳过，需开启 `skippable` |
| `skipOnDoubleClick` | `false` | 双击跳过，并在双击处播放涟漪过渡；需开启 `skippable`（可由设置页覆盖） |
| `rippleMs` | `1800` | 涟漪过渡时长，1–10000 毫秒 |
| `rippleReveal` | `true` | 关闭后双击仍可跳过，但改为普通淡出 |
| `showSkipHint` | `false` | 显示跳过提示；开启双击跳过时提示文案变为「双击或 Esc 跳过」 |
| `fadeMs` | `420` | 淡出时长，0–5000 毫秒 |
| `maxDurationMs` | `0` | 文档就绪后的播放上限，0–600000 毫秒；0 使用动画时长除以倍速，加 400 毫秒余量 |
| `loadTimeoutMs` | `6000` | 文档加载超时，500–60000 毫秒 |
| `debug` | `false` | 输出浏览器控制台诊断日志 |

存储不可用时，播放频率限制会失效，但动画仍能播放。加载失败不会消耗会话次数或冷却时间。

临时禁用一次：在页面地址添加 `?noopening`（已有查询参数时使用 `&noopening`）或 `#noopening`。

浏览器控制台 API：

```javascript
DSHOpening.play()                     // 手动重播，绕过频率限制和 URL 抑制；播放中返回 false
DSHOpening.skip()                     // 结束当前播放
DSHOpening.isPlaying()                // 是否正在播放
DSHOpening.config                     // 当前生效的配置（含用户开关合并后的结果）
DSHOpening.setIdentity('名字')         // 设置 ID CONFIRMED 后显示的文字
DSHOpening.setPrefs({ ... })          // 运行时应用设置页开关，等价于下一次加载读到的值
```

## 故障排查

将下面的端口替换成实际 DSH 服务端口：

```powershell
Invoke-RestMethod http://127.0.0.1:19387/dsh-opening/health.json
```

- 404：确认插件安装到了当前 profile，检查宿主启动日志并重启。
- `observed.served.loader` 为 0：页面尚未刷新，或 index 注入未生效。
- `served.loader` 大于 0、`served.splash` 为 0：检查配置、URL 抑制和播放频率限制。
- 黑屏或异常退出：开启 `debug`，查看资源请求和 `observed.events`。
- `identityPatched` 为 false：动画文件与宿主的名称替换锚点已不匹配，账号名不会出现；更换 `assets/splash.html` 后请一并更新 `lib/index.js` 的 `IDENTITY_LITERAL`。
- 双击没有涟漪：确认「双击跳过」已开启（或配置里 `skipOnDoubleClick: true`），且 `rippleReveal` 不为 false；引擎不支持 `mask-image` 时会退化为淡出。
- 桌面端双击无反应：动画文档里的 bridge 由宿主配置生成，父页面会在动画就绪时投影设置页开关；若宿主日志显示 `ready` 消息已到达，则检查 `skipOnDoubleClick` 是否真的写进了 `localStorage` 的 `dsh-opening-splash:settings`。

`observed.lastPlayback.reason`：`completed` 表示结束信号或预计时长到达，`key` / `click` / `dblclick` / `api` 表示提前结束，`load-timeout` 表示加载超时，`capped` 表示达到指定上限。计时器结束不证明每帧均已渲染，诊断上报也不能替代视觉检查。双击结束的过渡会以 `via=skip` 记录，与按 Esc、单击的记法一致。

诊断数据仅保存在宿主内存，重启后清零；上报含视口尺寸、浏览器 User-Agent 和结束原因，不写入磁盘。`played` 路由无鉴权，每类上报限速 500 毫秒，字符串长度和事件数量受限，不能当作可信审计记录。

使用 `link:` 安装时，修改 `lib/index.js` 必须重启宿主；修改 `assets/` 后刷新页面即可重新读取。更换动画时还需同步更新宿主的 `ANIMATION_DURATION_MS`，保证跨源兜底计时准确。



## 已知限制

源码已缓存动画元素、插值数据和重复查询的节点集合；圆盘仅在几何变化阶段更新，重复 SVG 路径不再写回，闪光结束后移除动态模糊滤镜，扫描条位移改用 `transform`。这些优化保留原动画时序和路径形状；实际帧率仍取决于宿主、窗口尺寸和 GPU，未承诺固定帧率。

动画按 16:9 等比缩放，其他宽高比会留黑边。插件覆盖页面内容，不能遮住 Electron / Windows 的原生窗口控制按钮。后台标签页的动画帧可能被节流，兜底计时仍可能结束覆盖层。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-opening-splash
```

## 来源与使用范围

动画对照《明日方舟》“Rhine Lab: Access”片头制作，并替换为 DeepSeek 标识，详见 [PROVENANCE.md](PROVENANCE.md)。这是非官方插件，不表示与相关品牌存在隶属或认可关系。第三方品牌与参考作品的权利归各自权利人所有；包中的 MIT 声明不授予这些权利。仓库未附独立 LICENSE 文件，复用代码前应向维护者确认授权范围。
