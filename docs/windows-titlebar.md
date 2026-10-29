# 桌面端顶部那条白边：一次完整的定位过程

> 这个问题花了几轮才找到根因，过程比结论更有价值：它演示了**如何在不能调试的
> Electron 应用里**，靠读 `app.asar` 和应用自身的 DOM 把一层"看得见、摸不到"的原生 UI 解释清楚。

## 症状

DSH 桌面端（Windows）窗口顶部有一条约 40px 的白色横条，壁纸铺满其余区域，白条始终不消失。
页面里用 CSS 清掉了所有能查到的背景，白条不动。

## 走过的三条死路

1. **"是原生菜单栏"** → 用 `GetMenu(hwnd)` 查询，返回 `0`，窗口根本没有 Win32 菜单。排除。
2. **"是页面里的某个 div"** → 在页面里查 `document.elementFromPoint(vw/2, 10)`，返回的是应用根容器
   （背景已被我们清成透明），说明那个位置**没有** DOM 元素覆盖。排除。
3. **"按面积放行大块容器"** → 白条只有 40px 高，占视口面积 2.8%，被"面积 > 6%"的判据漏掉。
   放宽后仍然无效，说明它根本不是普通 div。

## 真正的定位方法

### 第一步：量窗口几何

```powershell
GetWindowRect($h)  # 1295x829
GetClientRect($h)  # 1280x821
```

差值只有 8×13，**客户区几乎等于整个窗口**——所以 40px 的白条一定在客户区**内部**，
不是窗框。这就把"原生标题栏"和"页面内容"两类嫌疑同时圈住了。

### 第二步：在 `app.asar` 里搜关键词

asar 本质是个拼接归档，字符串是明文，可以直接按字节搜索：

```powershell
$text = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes('app.asar'))
$text.IndexOf('titleBarOverlay')
```

命中窗口创建代码：

```js
new BrowserWindow({
  titleBarStyle: 'hidden',
  titleBarOverlay: {
    height: 40,
    color: chromeFallbackFill(),
    symbolColor: nativeTheme.shouldUseDarkColors ? '#f9fafb' : '#0f1115',
  },
})
```

**这就是那条白条**：Electron 的 `titleBarOverlay`，画在页面之上，CSS 碰不到。

### 第三步：找它的颜色从哪来

继续搜 `setTitleBarOverlay`，找到 IPC 处理：

```js
ipcMain.on(DESKTOP_IPC.windowsAppearance, (event, language, color, symbolColor) => {
  if (!event.senderFrame.url.startsWith('dsh-app://app/')) return
  const validColor = (v) => /^(?:#[\da-f]{3,8}|rgba?\([\d.,%\s]+\))$/iu.test(v)
  if (validColor(color) && validColor(symbolColor)) mainWindow.setTitleBarOverlay({ color, symbolColor })
})
```

再看 preload 里谁发这个 IPC：

```js
const probe = document.createElement('span')
probe.style.cssText = 'position:fixed;visibility:hidden;background-color:var(--dsw-specific-sidebar-fill)'
document.body.append(probe)
// …
const color = nativeColor(getComputedStyle(probe).backgroundColor)
ipcRenderer.send(DESKTOP_IPC.windowsAppearance, root.lang, color, symbolColor)
```

**结论：原生标题栏的颜色，是由页面里的 CSS 变量 `--dsw-specific-sidebar-fill` 决定的。**

### 第四步：找页面上那 40px 是谁画的

在 asar 里搜 `data-windows-titlebar`，找到应用自己的样式：

```css
[data-windows-titlebar] .frame::before {
  content: "";
  height: var(--dsh-windows-titlebar-height);   /* 40px */
  background: var(--dsw-specific-sidebar-fill);
  -webkit-app-region: drag;
  position: absolute;
  inset: 0 0 auto;
}
```

于是真相是：**同一条白边有两层**——页面里的 `::before` 伪元素 + 原生 overlay，
两者共用同一个变量。

## 修复

```js
// 1) 把变量置透明（同时干掉伪元素和原生 overlay 的颜色来源）
document.documentElement.style.setProperty('--dsw-specific-sidebar-fill', 'rgba(0,0,0,0)', 'important')

// 2) 再加一层样式兜底，防止主题运行时把它写回去
'html{--dsw-specific-sidebar-fill:rgba(0,0,0,0)!important}',
'[data-windows-titlebar] [class*="frame"]::before{background:transparent!important}'

// 3) preload 只在 body 的 childList 变化时重算颜色，所以每 2 秒插一个 0 尺寸节点"敲"一下
```

`-webkit-app-region: drag` 保留，顶部 40px 仍然可以拖动窗口，只是不再有白底。

## 可复用的方法论

1. **先量几何**：`GetWindowRect` vs `GetClientRect` 的差值能直接区分"窗框/原生 chrome"和"页面内容"。
2. **`GetMenu` 能快速排除 Win32 菜单**。
3. **`elementFromPoint` + `elementsFromPoint` 是"这东西在不在 DOM 里"的判据**：
   返回空或返回容器本身，基本可以断定是浏览器合成的层（overlay / pseudo / shadow）。
4. **Electron 应用的字符串全在 asar 里**，`titleBarStyle`、`titleBarOverlay`、`setTitleBarOverlay`、
   `contextBridge.exposeInMainWorld`、IPC 通道常量，都是能直接搜到的。
5. **界面颜色常常由应用自己"同步"给原生层**：找到一个 `probe span + getComputedStyle + ipcRenderer.send`
   的组合，就找到了那条链路；改页面变量即可反控原生外观。

## 注意事项

- 依赖变量名 `--dsw-specific-sidebar-fill` 与属性名 `data-windows-titlebar`，DSH 大版本改名后需同步调整。
- 把该变量置透明也会影响侧栏底色（本项目本来就是"整窗透出"，符合预期）；如果你只想动标题栏，
  把第 1 步换成只覆盖 `[data-windows-titlebar] .frame::before`，并另行触发一次颜色同步。
