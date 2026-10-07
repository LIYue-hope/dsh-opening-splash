# DSH Opening Splash

为 DeepSeek Harness 页面添加启动开场动画的 DSH bundle 插件。动画在独立 iframe 中播放，默认约 20.25 秒，结束后淡出进入主界面；默认可按 Esc 跳过，点击不会跳过。

插件使用 Node.js 内置模块，没有运行时依赖。支持浏览器页面和官方 Electron 桌面端的两种 index 注入通道。

## 安装

需要 Node.js 20 或更新版本，以及支持 DSH bundle、`webServer` 和 index 注入接口的 DeepSeek Harness。此前在桌面端 0.2.0-rc.2 确认过播放；本次修订通过离线测试，尚未重新验证桌面端画面。

下载或克隆仓库后，将插件目录安装到实际使用的 profile。例如 Windows 桌面 profile：

```powershell
dsh plugin --profile desktop add link:D:\path\to\dsh-opening-splash
dsh plugin --profile desktop list
```

安装后重启 DeepSeek Harness 并刷新页面。路径必须指向含 `package.json` 的插件目录。其他 profile 请替换 `desktop`。本项目不承诺已发布到 npm。

## 配置

默认配置位于 [cordis.patch.yml](cordis.patch.yml) 的 `config` 中，未列出的字段可自行添加。修改配置后重启宿主。

| 字段 | 默认值 | 含义与范围 |
|---|---|---|
| `enabled` | `true` | 是否注入启动动画；关闭后诊断路由仍保留 |
| `speed` | `1` | 播放倍速，0.1–8 |
| `oncePerSession` | `false` | 使用 sessionStorage，在同一标签页会话中只播放一次 |
| `cooldownMs` | `0` | 使用 localStorage 控制播放间隔，0–2592000000 毫秒 |
| `skippable` | `true` | 是否允许通过键盘或点击跳过；显式 API 仍可结束播放 |
| `skipOnAnyKey` | `false` | 任意按键跳过，需开启 `skippable` |
| `skipOnClick` | `false` | 点击跳过，需开启 `skippable` |
| `showSkipHint` | `false` | 显示“Esc 跳过”提示 |
| `fadeMs` | `420` | 淡出时长，0–5000 毫秒 |
| `maxDurationMs` | `0` | 文档就绪后的播放上限，0–600000 毫秒；0 使用动画时长除以倍速，加 400 毫秒余量 |
| `loadTimeoutMs` | `6000` | 文档加载超时，500–60000 毫秒 |
| `debug` | `false` | 输出浏览器控制台诊断日志 |

存储不可用时，播放频率限制会失效，但动画仍能播放。加载失败不会消耗会话次数或冷却时间。

临时禁用一次：在页面地址添加 `?noopening`（已有查询参数时使用 `&noopening`）或 `#noopening`。

浏览器控制台 API：

```javascript
DSHOpening.play()       // 手动重播，绕过频率限制和 URL 抑制；播放中返回 false
DSHOpening.skip()       // 结束当前播放
DSHOpening.isPlaying()  // 是否正在播放
DSHOpening.config      // 加载时的配置
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

`observed.lastPlayback.reason`：`completed` 表示结束信号或预计时长到达，`key` / `click` / `api` 表示提前结束，`load-timeout` 表示加载超时，`capped` 表示达到指定上限。计时器结束不证明每帧均已渲染，诊断上报也不能替代视觉检查。

诊断数据仅保存在宿主内存，重启后清零；上报含视口尺寸、浏览器 User-Agent 和结束原因，不写入磁盘。`played` 路由无鉴权，每类上报限速 500 毫秒，字符串长度和事件数量受限，不能当作可信审计记录。

使用 `link:` 安装时，修改 `lib/index.js` 必须重启宿主；修改 `assets/` 后刷新页面即可重新读取。更换动画时还需同步更新宿主的 `ANIMATION_DURATION_MS`，保证跨源兜底计时准确。

## 开发与验证

```powershell
$projectTestTmp = Join-Path (Get-Location) '.codex\test-tmp'
New-Item -ItemType Directory -Force $projectTestTmp | Out-Null
$env:TEMP = $projectTestTmp
$env:TMP = $projectTestTmp
$env:TMPDIR = $projectTestTmp
$env:TEST_TMPDIR = $projectTestTmp
npm test
```

测试不需要安装依赖，覆盖配置、路由、生成脚本的解析与执行、注入去重、播放控制、跨源兜底和诊断上报。浏览器测试使用 DOM 桩，不检查实际画面；请另在 DSH 中检查完整播放、Esc、配置关闭和刷新行为。

```text
assets/splash.html   自包含动画
assets/opening.js    覆盖层、播放控制和诊断
lib/index.js        宿主路由、配置和注入桥接
cordis.patch.yml    DSH 挂载声明
PROVENANCE.md       动画来源与品牌说明
tests/              离线回归测试
```

## 已知限制

动画按 16:9 等比缩放，其他宽高比会留黑边。插件覆盖页面内容，不能遮住 Electron / Windows 的原生窗口控制按钮。后台标签页的动画帧可能被节流，兜底计时仍可能结束覆盖层。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-opening-splash
```

## 来源与使用范围

动画对照《明日方舟》“Rhine Lab: Access”片头制作，并替换为 DeepSeek 标识，详见 [PROVENANCE.md](PROVENANCE.md)。这是非官方插件，不表示与相关品牌存在隶属或认可关系。第三方品牌与参考作品的权利归各自权利人所有；包中的 MIT 声明不授予这些权利。仓库未附独立 LICENSE 文件，复用代码前应向维护者确认授权范围。
