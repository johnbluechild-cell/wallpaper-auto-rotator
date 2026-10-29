# 架构

## 组件

| 组件 | 跑在哪 | 职责 |
|---|---|---|
| `dsh-wallpaper-engine-api`（第三方，MIT） | DSH 进程内 | 解析 Steam 订阅清单，在 `127.0.0.1:8088` 提供只读目录 `/api/wallpapers` |
| `plugin/index.js`（host） | DSH 进程内 | 目录聚合、洗牌、路由、静帧接入、后台提取看门狗 |
| `plugin/client.js`（client） | 渲染进程 | 壁纸层、主题覆盖、控件 |
| `tools/*.py` | 子进程（按需） | 离线把 `scene.pkg` 变成 4K 静帧 |

host 与 client 通过 HTTP 路由通信（同源），不共享内存；client 由 DSH 的 client module loader 加载，
所以**桌面端和 `dsh web` 用同一份代码**。

## 路由

| 路由 | 方法 | 说明 |
|---|---|---|
| `/wp/state` | GET | 总数、当前游标、间隔、压暗、仅高清、待处理静帧数、客户端自检回传 |
| `/wp/show?step=±1` | GET | 推进游标并返回 `{url, kind, title, w, h, sharp, index, total}` |
| `/wp/img?id=` | GET | 图片流式输出，带 `ETag` / `Cache-Control: max-age=604800` |
| `/wp/video?id=` | GET | 视频流式输出，支持 `Range`（206），不转码 |
| `/wp/config?…` | GET | `interval` / `scrim` / `paused` / `sharp` / `reshuffle` / `refresh` |
| `/wp/diag?d=` | GET | client 把自身 DOM 状态回传，用于排障 |

所有路由都是 `exact` 类型，没有静态目录，也没有路径拼接，`id` 必须是目录里存在的壁纸。

## 目录与画质模型

一张壁纸在内部是：

```js
{ id, title, type, path, video?, still?, w, h, sharp }
```

- `video`：`project.json` 的 `file` 指向真实 mp4 时填上（否则回退到目录里第一个视频）
- `still`：`cache/stills/<id>.jpg` 存在时把 `path` 换成它
- `sharp`：视频恒为真；图片按 `w >= 1280` 判定
- `state.sharpOnly`（默认开）决定轮换池是否只取 `sharp`

目录缓存 120 秒；id 集合变化时重新洗牌并把游标归零——这就是"新订阅自动进池"的机制。

## 洗牌

启动时对可见集合做一次 Fisher–Yates（`visible()` 已按 `sharpOnly` 过滤）。
顺序只存在内存里，进程重启即重新洗牌，所以"每次开机顺序不同"不需要落盘。

## 静帧看门狗

```
apply() ──► 启动 20s 后第一次
        └─► 之后每 10 分钟
              │
              ├─ 扫描 workshop 目录，找出「有 scene.pkg、没静帧、也没被标记失败」的
              ├─ 有 → spawn(python, tools/still-extract.py, detached, windowsHide)
              └─ 脚本自带 .running 文件锁，重复触发直接退出
```

提取脚本是**增量**的：已存在且非失败的一律跳过；失败写 `{"fail": true}`，不会无限重试
（想重来用 `--force`）。这样即使订阅了几十个壁纸，也只在后台慢慢跑，不阻塞 DSH 启动。

## 客户端渲染

1. `position:fixed; inset:0` 的 stage 插到 `body` 最前面，内部两个 slot 做交叉淡化
2. stage 里再叠一层 scrim（压暗层），颜色随主题
3. 覆盖 `--dsw-alias-bg-*` 系列变量为半透明
4. 遍历 DOM，把"面积 > 6% 视口"或"全宽矮条（≥45% 宽、14–200px 高）"的**不透明**容器背景清掉
5. 伪元素用 `[data-wpv2-strip]` 属性 + 注入样式清理
6. 顶部/底部条额外清 `backdrop-filter` / `box-shadow`，避免毛玻璃挡住壁纸

第 3–6 步合起来，就是"壁纸铺满整窗而不是只在内容区"的全部原因。
桌面端还多一步：把 `--dsw-specific-sidebar-fill` 置透明，具体见 [`windows-titlebar.md`](windows-titlebar.md)。

## 集成方式

插件声明了 `dsh.client`：

```json
"dsh": {
  "client": { "platform": "web", "immediately": true, "inject": [] },
  "bundle": { "patch": "./cordis.patch.yml" }
}
```

host 端通过 `ctx.inject(['webServer'])` 注册路由；client 端由模块加载器加载，
入口是 `window.__ModuleLoader__.load({ id, factory })` 包装的 `apply(ctx)`。

**不要用 `webServer.tapIndex` 注入 `<script>`**：桌面端的界面从本地 bundle 加载，
不经过 HTTP 首页，注入永远不生效——这是本项目第一版踩过的坑。
