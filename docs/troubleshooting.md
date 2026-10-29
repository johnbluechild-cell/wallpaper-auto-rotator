# 排障

## 插件装好了但界面没反应

按顺序确认：

1. **host 有没有起来** —— 访问 `http://127.0.0.1:<端口>/wp/state`，应返回 JSON。
   404 表示插件没被加载；200 但页面无变化表示问题在 client 侧。
2. **client 有没有挂上** —— 再访问一次 `/wp/state`，看 `index` 是否从 0 变成 1。
   client 挂载成功会立刻调用一次 `/wp/show`，游标必然前进。
3. **桌面端是不是走的 HTTP** —— 桌面端界面从本地 bundle 加载，`webServer.tapIndex` 注入
   **永远不会生效**。必须声明 `dsh.client` 用模块加载器加载（见 `plugin/package.json`）。

## 顶部白边还在

见 [`windows-titlebar.md`](windows-titlebar.md)。快速自检：

```js
getComputedStyle(document.documentElement).getPropertyValue('--dsw-specific-sidebar-fill')
// 期望：rgba(0,0,0,0)
```

如果值是透明的但白边还在，说明 preload 没把新颜色同步过去——它只监听 `body` 的 `childList`，
插件里那个"每 2 秒插一个 0 尺寸节点"的 nudge 就是干这个的，确认它没被注释掉。

## 壁纸只出现在内容区，侧栏是实底

侧栏一类容器的底色常常写死在组件样式里，改 CSS 变量够不到。项目里的做法是遍历 DOM，
把"面积 > 6% 视口"或"全宽矮条"的**不透明**容器背景清掉。
如果 DSH 改版导致类名/结构变化，调 `client.js` 里的 `neutralize()`：

- 缩小面积阈值（`area * 0.06`）
- 或者在 `DIALOG_SEL` 黑白名单里补规则（弹窗、下拉菜单不能被清）

## 有的壁纸很糊

先看面板显示的分辨率：

- `192×192 · 低清` —— 场景型且没有静帧，只有工坊预览图。跑一次
  `python tools/still-extract.py`（或等看门狗），成功后变成 `3840×2160 · 高清`。
- `视频 · 原始 mp4` —— 视频型，糊说明源本身分辨率低。

## 静帧提取一直失败

```powershell
python tools/still-extract.py --force   # 重试所有失败项
```

常见原因：

- `REPKG_EXE` 路径不对，或没装 .NET 运行时（RePKG 需要 .NET 6+）
- 该壁纸确实没有可用图层（只有特效遮罩）：会被标记 `fail`，退回预览图
- 磁盘权限：`WE_STILLS` 指向的目录不可写

## 8088 端口被占用

`dsh-wallpaper-engine-api` 会探测已有服务并复用；若被无关程序占用会自动换端口。
如果插件的 `WP_WE_BASE` 写死了旧端口而服务换了端口，会一直走本地目录扫描
（功能不受影响，只是标题会退化成 id）。把 `WP_WE_BASE` 留空或指向实际端口。

## 装完过一阵子插件消失了

多半是别的插件工具的 `pnpm install` 把手工放进 `node_modules` 的目录当多余包清掉了。
用 `dsh plugin add` 装成正式依赖，或重新执行 `scripts/deploy-desktop.ps1`。

## 面板控件挡住界面 / 不想要了

- 面板：点空白处自动收起；`关闭` 按钮同样只收起面板
- 整个功能：把 `cordis.patch.yml` 里的 insert 删掉重启即可；桌面端可用
  `scripts/deploy-desktop.ps1 -Uninstall` 一键回滚（含配置备份）
