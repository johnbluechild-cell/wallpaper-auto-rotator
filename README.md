# 永久自动轮换工作区壁纸（接 Wallpaper Engine 版）

> 给 DeepSeek Harness（DSH）网页工作区自动轮换背景壁纸，自动同步 Wallpaper Engine 新下载的壁纸，
> 并附一个 Windows 桌面悬浮宠物——单击即可用拖动条调节透明度、轮换间隔，勾选要轮换的图片、手动换图。

## 功能特性

- ✅ 工作区背景壁纸自动轮换（默认每 180 秒，可调）
- ✅ 自动扫描并同步 Wallpaper Engine 的壁纸预览（Workshop 订阅 + 本地项目）
- ✅ 桌面悬浮小猫 🐱：单击弹出设置面板（透明度拖动条 + 轮换间隔拖动条 + 图片勾选列表 + 「换一张」+「刷新列表」）
- ✅ 设置即时生效，重启电脑 / DSH 后自动恢复（持久化插件 + 开机自启）
- ✅ 每张图可单独启用 / 停用；新下载的壁纸约 1 分钟内自动进入轮换
- ✅ 不影响电脑桌面壁纸

## 目录结构

```
wallpaper-auto-rotator/
├── dsh-plugin/            # DSH 持久化插件（核心，重启后自动生效）
│   ├── package.json
│   └── index.js           # 注册 /wallpaper/* 路由 + 注入轮换脚本
├── desktop-pet/           # Windows 桌面宠物
│   ├── wallpaper-pet.ps1  # 悬浮小猫 + 设置面板
│   ├── wallpaper-pet.vbs  # 开机自启启动器
│   └── wallpaper-settings.example.json
├── dynamic-plugin/        # 动态插件源码（会话级原型参考，已被 dsh-plugin 取代）
│   ├── host.js
│   └── client.js
├── README.md
└── LICENSE
```

## 安装

### 1. 安装 DSH 持久化插件

1. 找到 DSH 的 hoisted node_modules 目录（与 `dsh-plugin-desktop` 同处，通常在
   `%DSH_HOME%\profiles\node_modules\`）。
2. 把 `dsh-plugin/` 目录复制为 `%DSH_HOME%\profiles\node_modules\wallpaper-rotator\`。
3. 在该 profile 的 `cordis.patch.yml`（注意是 patch，不是 cordis.yml——后者会被 DSH 启动重置）里追加：

   ```yaml
   - insert:
       - id: wallpaper-rotator
         name: wallpaper-rotator
   ```

4. 重启 DSH。

插件会注册 `/wallpaper/list`、`/wallpaper/data`、`/wallpaper/settings`、`/wallpaper/rotator.js`
四个 HTTP 路由，并向每个页面注入轮换脚本。

### 2. 安装桌面宠物

1. 把 `desktop-pet/wallpaper-pet.ps1` 放到 `%DSH_HOME%\` 下。
2. 用「计划任务」运行，使其独立于 DSH（这样重启 DSH 也不会关掉小猫）：

   ```powershell
   schtasks /Create /F /TN wallpaper-pet /SC ONLOGON /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File %DSH_HOME%\wallpaper-pet.ps1"
   schtasks /Run /TN wallpaper-pet
   ```

   备选：把 `desktop-pet/wallpaper-pet.vbs` 放入 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`（登录时启动）。

### 3. 配置文件

创建 `%DSH_HOME%\wallpaper-settings.json`：

```json
{
  "opacity": 0.28,
  "intervalSec": 180,
  "disabled": [],
  "nextTick": 0
}
```

| 字段 | 含义 |
| --- | --- |
| `opacity` | 面板不透明度（0~1，越小图片越清晰，默认 0.28） |
| `intervalSec` | 轮换间隔（秒，默认 180） |
| `disabled` | 停用的图片名列表（对应图片列表里的名字） |
| `nextTick` | 「换一张」计数器，宠物递增它触发立即换图 |

## 壁纸来源（自动同步）

- Workshop：`<steam>\steamapps\workshop\content\431960\*\preview.jpg/png/webp/gif`
- 本地项目：`<steam>\steamapps\common\wallpaper_engine\projects\myprojects\**` 下的 `preview.*` 与 `materials\*.png`

> 注意：动画壁纸的 `preview.gif` 只是 160–224px 的小预览（真正的 4K 视频在 `scene.pkg` 里，
> 是 Wallpaper Engine 的专有封装格式，浏览器无法直接使用），全屏会偏糊，可在宠物里取消勾选停用。

## 关于动态插件（dynamic-plugin）

`dynamic-plugin/` 是早期会话级原型（用 DSH 的 `cordis_define` / `cordis_run` 挂载），
只能存活在单个 DSH 进程内，重启后消失。它已被 `dsh-plugin/`（正式持久化插件）取代，保留作为参考。

## License

MIT
