# 来源与替换关系

## 动画本体

`assets/splash.html` 是工作区交付物 `../../deepseek-harness-opening.html` 的**逐字节副本**：

| 文件 | 字节 | SHA-256（前 32 位） |
|---|---|---|
| `deepseek-harness-opening.html`（工作区交付物） | 43140 | `8e3d7a40b93ead5ff37668835ae1d5a2` |
| `assets/splash.html`（插件内） | 43140 | `8e3d7a40b93ead5ff37668835ae1d5a2` |

磁盘中的动画保持原样；宿主在响应时添加 bridge，以便控制倍速、跳过、账号名称消息和结束通知，并将身份文字替换为动态读取、加入长名称宽度适配。iframe 在桌面端可能跨源。替换 `assets/splash.html` 时还需同步更新 `lib/index.js` 的 `ANIMATION_DURATION_MS`，确保无消息时的兜底计时准确。

## 它是什么

一段对照复刻的软件开场动画。原作是《明日方舟》特别视频 **"Rhine Lab: Access"** 的 **7 s – 26 s** 片头（源 `BV1rr4y1b7sz`），复刻时按原速 1:1 映射到 0 – 19000 ms，再加 900 ms 定格和 350 ms 收尾，总长约 **20.25 秒**。

替换关系：

| 原作 | 复刻 |
|---|---|
| Rhine Lab 标志 | DeepSeek 鲸鱼 |
| `RHINE LAB` | `DEEPSEEK` |
| `RHINE LAB.LLC.` | `DEEPSEEK HARNESS` |
| `POWERED BY ...` | `POWERED BY DEEPSEEK HARNESS` |

## 技术约定（继承自工作区，插件一并遵守）

- **UTF-8 无 BOM**，且**全文件纯 ASCII**：中点写作 HTML 里的 `&middot;`、JavaScript 里的 `\u00b7`。`assets/opening.js`、`lib/index.js`、`README.md` 之外的源码同样如此，中文一律用 `\uXXXX` 转义 —— 这样任何编辑器和 shell 的文本往返都不会把它变成乱码。
- **单文件自包含**：动画不引用任何外部资源，字体只用系统字体，噪点与虚焦背景都用内联 SVG / data URL 程序化生成。
- 所有数值都是**测出来的**，不是估的：环带半径、缺口角度、盘的圆心都由工具链在原生帧上做圆拟合和极坐标展开后确定。

## 工作区里其余内容的关系

插件只包含动画本体和让它跑起来的宿主/浏览器胶水。工作区里剩下的东西是这项复刻工作的**来源记录**，不属于插件、不随插件发布：

| 目录 | 内容 |
|---|---|
| `ref/` | 参考视频 `ref_480p.mp4`、流地址、帧播放器页 |
| `frames/` | 参考视频按 25 fps 解码的原生帧，以及按场景分组的帧和盘部放大图 |
| `shots/` | 参考视频的接触表，以及复刻版在特定时刻的渲染 |
| `assets/brand/` | 官方 DeepSeek 品牌资产（鲸鱼路径、logo） |
| `docs/` | 分析产物：对照图、对齐差异、极坐标展开、编码修复报告、逐版迭代记录 |
| `tools/` | 全部测量、分割、重建、校验脚本 |
| `bin/` | 静态 `ffmpeg.exe` |

想重新核对动画与参考视频的差异，用 `tools/` 里那套脚本；`docs/iteration-v*.md` 记录了每一版改了什么、为什么。
