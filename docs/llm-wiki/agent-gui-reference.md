# Agent GUI 对标纪要

本地参考克隆：`.refs/aider-desk`（gitignore，勿提交）。

## 借鉴来源

| 来源 | 借鉴点 | 落地 |
|------|--------|------|
| **AiderDesk** `ProjectFilesSection` / `FileViewerModal` | 项目文件树 + 读文件预览 + 搜索/刷新 | `ResourceViewer` + `fs_list_dir` / `fs_read_file` |
| **Grok Build 权限文档** | `default` / `acceptEdits` / `dontAsk` / `bypassPermissions` | `PERMISSION_POLICIES` + Host `PermissionPolicy` |
| **产品 sheet UI（参考图）** | 两 chip：模型+努力 / 访问（模式+权限合并）；窄宽压缩为短文案或仅图标 | `ComposerModelMenu` · `ComposerAccessMenu` |
| **OpenHands Canvas / 通用三栏** | 左会话 / 中对话 / 右资源，侧栏可关 | `sidebar--hidden` / `aside--hidden` + 顶栏 icon |
| **会话变更审阅（L06）** | Agent 写/改文件列表 + unified diff / 外开编辑器 | `ResourceViewer` Changes 模式 + `sessionChanges` + 可选 `git_file_diff` |

## 交互约定

1. 左、右栏**彻底关闭**（width 0，无 icon rail）；顶栏 `IconPanel` / `IconFiles` 开关。
2. 右栏 = 当前项目资源查看器（会话项目路径），多格式预览（text/code/md/json/csv/html/image/svg/pdf/audio/video）。
3. Composer 模型区合并为 ⚡ 菜单：模型 / 推理强度 / 授权模式；高级里放会话 mode。
4. **Changes（会话变更）**：右栏 chrome 的 diff 图标 + 侧栏 **Files | Changes** 切换。  
   - 来源：`session://tool` 中 write/edit 类工具（`isEditToolKind`）与历史 `tool_step` 消息。  
   - 点击条目：优先工具 payload 的 before/after → 本地 unified diff；否则尝试 `git_file_diff`（git 可选）；再否则展示当前文件内容 + 外开/Reveal。  
   - 纯 helper：`src/lib/sessionChanges.ts`（normalize / merge / unified diff）。
