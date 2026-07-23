# 应用内弹窗（禁止 window.confirm / prompt）

**强制**：Tauri WebView 下 **`window.confirm` / `window.prompt` / `window.alert` 不可靠**（常无对话框、恒为 false、或阻塞异常）。  
用户确认、输入、危险操作 **必须** 使用应用内弹窗，禁止再引入浏览器原生对话框。

## 视觉：统一毛玻璃

所有浮层（确认框、业务弹窗、下拉菜单、搜索面板、侧滑表单、toast、权限条）共用 **同一套毛玻璃材质**：

| Token | 用途 |
|-------|------|
| `--glass-surface` / `--glass-surface-solid` | 半透明底 / 无 blur 回退 |
| `--glass-border` / `--glass-blur` / `--glass-saturate` / `--glass-shadow` | 边框、模糊、饱和、阴影 |
| `--menu-*` | 下拉菜单布局（圆角 12、外 pad 6、item 圆角 8） |
| `--modal-*` | 对话框布局（圆角 16、pad 20×24、gap 16） |
| `--bg-sidebar` + `--sidebar-blur` | 左栏 80% 透明 + 更强模糊 |

CSS 入口：`.glass-surface` 以及 `.modal` / `.menu-panel` / `.search-panel` / `.cmm__pop` / `.effort-panel__pop` / `.auto-panel` 等选择器（见 `src/styles/app.css`）。

**禁止** 在浮层上再写 `background: var(--bg-elevated)` 等不透明底，否则盖住毛玻璃。

## 公共壳：`GlassModal`

新业务弹窗优先用：

```tsx
import { GlassModal } from "@/components/GlassModal";

<GlassModal
  open={open}
  onClose={onClose}
  title={tr("…")}
  size="sm" | "md" | "lg"   // 420 / 480 / 560
  closeLabel={tr("common.close")}
  footer={
    <>
      <button type="button" className="btn btn--ghost" onClick={onClose}>
        {tr("common.cancel")}
      </button>
      <button type="button" className="btn btn--solid" onClick={onSave}>
        {tr("common.save")}
      </button>
    </>
  }
>
  {/* 业务内容 */}
</GlassModal>
```

结构：`.overlay` → `.modal.glass-modal[--sm|--md|--lg]` → `header.modal-head` + body + `.modal-actions`。

存量也可用同一 DOM/CSS（不强制立刻迁组件）：

```html
<div class="overlay">
  <div class="modal app-dialog" role="dialog">…</div>
</div>
```

## 首选：App 级 `appDialog`（`src/App.tsx`）

工作台内主流程（项目 / 会话重命名、YOLO 二次确认等）使用：

```ts
setAppDialog({
  kind: "confirm",
  title: tr("…"),
  message: tr("…", { name }),
  confirmLabel: tr("…"), // optional
  danger: true,          // optional → 危险按钮样式
  onConfirm: () => { void doSomething(); },
});

// 或输入
setAppDialog({
  kind: "prompt",
  title: tr("…"),
  initial: current,
  placeholder: tr("…"),
  onSubmit: (value) => { void rename(value); },
});
```

- 渲染：`createPortal` → `.app-dialog-overlay` + `.modal.app-dialog`。  
- 文案：全部走 `src/i18n/`（见 [i18n.md](./i18n.md)）。  
- **禁止** 在 `onConfirm` / `onSubmit` 里再套 `window.confirm`。

## 子页面 / 独立面板

若组件拿不到 `setAppDialog`（如 `AutomationsPage`）：

1. **优先**：通过 props 回调把确认上抛到 `App`（`onRequestConfirm`），由 `appDialog` 统一处理。  
2. **可接受**：组件内用同一套 DOM/CSS 自建确认（`createPortal` + `overlay` / `modal app-dialog`），或 `GlassModal`。  
3. 参考：`AutomationsPage` 删除确认（禁止 `window.confirm`）。

## 浮层清单（改样式时勿漏）

| 类型 | 选择器 / 组件 |
|------|----------------|
| App 确认/输入 | `.modal.app-dialog` · `setAppDialog` |
| Compact / Doctor / Status / MCP | `.modal` · `GlassModal` · `DoctorModal` |
| 文件详情 | `.modal.file-path-details` |
| 搜索面板 | `.search-panel` |
| 模型 / 强度 / 用户 / 斜杠 / + | `.cmm__pop` · `.effort-panel__pop` · `.menu-panel` · `.slash-palette` · `.composer-plus` |
| 上下文 / 附件 / 打开位置 / Select | `.ctx-menu` · `.att-menu` · `.open-loc-menu` · `.c-select__menu` |
| 自动化表单侧栏 / 行菜单 | `.auto-panel` · `.auto-row__menu` |
| Toast / 权限条 / 拖放卡 | `.app-toast` · `.perm-bar` · `.drop-overlay__card` |
| 左栏 | `.sidebar`（80% + `--sidebar-blur`） |

## 禁止清单

| API / 模式 | 状态 |
|------------|------|
| `window.confirm(...)` | **禁止** |
| `window.prompt(...)` | **禁止** |
| `window.alert(...)` | **禁止**（用户可见错误用 toast / error banner / 应用内 dialog） |
| `confirm` / `prompt` 全局别名 | **禁止** |
| 浮层不透明 `bg-elevated` | **禁止**（用 glass tokens） |

存量调用发现即改（搜索 `window.confirm`、`window.prompt`）。

## 验收

- [ ] 新增删除 / 信任 / 危险开关等路径均有应用内确认，无 `window.confirm`。  
- [ ] 确认框文案中英键齐全。  
- [ ] Tauri 真机：点确认执行、点取消/遮罩关闭、无「无反应」。  
- [ ] 危险操作（删除任务、YOLO、移除项目）使用 `danger` 样式并写清后果。  
- [ ] 暗/亮主题下弹窗与菜单均为半透明毛玻璃，可见背景模糊。  
- [ ] 左栏透明度约 80%，模糊强于浮层。

## 相关源码

- `src/components/GlassModal.tsx` — 公共对话框壳  
- `src/App.tsx` — `AppDialog` 类型、`setAppDialog`、portal 渲染  
- `src/styles/tokens.css` — `--glass-*` / `--menu-*` / `--modal-*` / sidebar  
- `src/styles/app.css` — 统一 glass 选择器 + modal/menu 布局  
- `src/components/StatusModal.tsx` / `McpStatusModal.tsx` — GlassModal 范例  
- `src/components/AutomationsPage.tsx` — 子页面自建删除确认范例  
- `src/i18n/messages.ts` — `common.cancel` / `common.confirm` / `common.close` 等  
