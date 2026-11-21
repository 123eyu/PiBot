# @pibot/ui

React 19 + CSS Modules，主题变量来自 `design/README.md`。仅此包依赖 React / React DOM；没有 UI 组件库、测试库或 Electron 依赖。

renderer 入口先加载一次 token 样式，再挂一个控制根元素的 ThemeProvider：

```tsx
import "@pibot/ui/tokens.css";
import { Avatar, Button, Logo, ThemeProvider } from "@pibot/ui";

<ThemeProvider theme="system">
  <Logo variant="mark" />
  <Avatar label="Pi" shape="blob" color="violet" eyes="marks" />
  <Button>{translate("welcome.pi.chat")}</Button>
</ThemeProvider>;
```

- `ThemeProvider` 的 `theme` 为 `system | light | dark`，默认 `system`，系统模式订阅 `prefers-color-scheme`。`useTheme()` 返回 `theme` 和 `resolvedTheme`。设置由宿主保存；Provider 修改 `document.documentElement.dataset.theme`，卸载时恢复原属性。SSR 不访问浏览器，系统模式的服务端快照为浅色。
- `Avatar`：12 种 shape、10 种 color、5 种 eyes、6 种 state；默认与主 Bot Pi 一致，size 默认 96。blocked / done 的眼睛覆盖所选眼睛。label 用于 SVG 无障碍名称；状态说明由宿主用 i18n 提供。动画遵循减少动态效果的系统偏好。
- `Logo`：mark、app-mac、app-win、app-linux、tray；tone 为 violet、ink、paper、night，size 默认 96。mark 是圆角方块脸，app-mac 是满铺正方形资源预览，app-win 是 blob，app-linux 是圆形。tray 是实心 blob 加透明眼睛；22px 及以下眼睛加粗。
- `Button`：primary / secondary / ghost，默认 `type=button`；loading 禁用按钮并显示装饰性进度圈。调用方传入本地化的可见文字。`IconButton` 需要本地化的 `label`。
- `TextField`：需要 label，原生 input props（含 ref）透传；自动关联 description / error；错误为 `aria-invalid` + alert。Key 输入用 `type=password`，保存逻辑在业务层。
- `Switch`：受控 checked + onCheckedChange，必填 label；支持原生 disabled 和键盘点击。
- `SegmentedControl`：受控 value + onValueChange，options 为 value / label / disabled。使用原生 radio 和 fieldset / legend，保留箭头键导航、Tab 聚焦和表单语义；name 不传时自动生成。
- `Card`：透传 div props（含 ref）。组件支持 className 扩展，颜色应继续只用 token。

tokens.css 同时定义字体栈、字体等宽栈、行 / 卡片 / 胶囊圆角、Avatar 和 Logo 的设计色盘。主按钮和用户气泡在深色主题下反色。组件中的 `none`、`transparent` 和 `currentColor` 为语义值；具体色值只允许出现在 tokens.css。

`@pibot/ui/logo` 是不加载 CSS Modules 的独立入口。桌面图标和托盘生成脚本直接从 `design/canvas/Logo.dc.html` 解析品牌色和几何，再交给 resvg，保持设计源唯一。

测试用 `react-dom/server` 验证结构、SVG 几何与可访问名称；色值扫描递归覆盖 src 中除 tokens.css 之外的全部文件，同时禁止 hex 和 RGB / HSL 等函数色值。renderer 扫描应在后续 renderer 任务接入，因为此任务不拥有 apps/desktop。
