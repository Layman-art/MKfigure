# MK Figure 0.6.2

## 修改

- 恢复 0.6.0 的浅色纸面、陶土色操作按钮、原首页和单图左侧五步导航。撤回 0.6.1 的 Research Workbench 风格试验，GitHub README 展示不受影响。
- 支持自行选择多个创作文件夹，侧栏保留入口，重启恢复上次活动目录。
- “从侧栏移除”仅移除入口，文件留在本地；重新打开可恢复作品和统一风格。
- 未选择目录时显示打开引导；有旧版本地作品时保留兼容入口。
- 新创作先保存为草稿，不进入作品列表；首次运行才成为正式作品并按内容命名，失败重试不重复新增。

## 验证（2026-10-18，Windows）

- `npm test`：169 项通过，2 项可选测试跳过。
- `npm run dist:win`：类型检查、生产构建和 NSIS 安装包生成成功。
- `scripts/workspace-ui-smoke.mjs`：开发版及打包程序均通过；覆盖六窗布局、单图展开、草稿保存、统一风格、目录切换和作品删除。
- `scripts/folder-sidebar-smoke.mjs`：打包程序通过；覆盖移除当前/非当前目录、移除后文件逐一 SHA-256 不变、重启恢复及重新打开作品。
- `scripts/draft-smoke.mjs`：草稿隐藏、重启恢复、首次运行转正、失败重试和旧草稿保存保护通过；`scripts/panes-smoke.mjs`：六窗同时运行、取消隔离与保存通过（本地模型桩）。
- 已查看实际首页、单图界面截图。界面测试使用独立数据目录，未发起云端模型推理。
- 未覆盖安装向导实装、macOS 运行；未覆盖或重启用户当前安装的软件。

## Windows x64 安装包

`release/MK-Figure-0.6.2-Windows-x64-Setup.exe`

大小：248,949,798 字节。

SHA-256：`3e86a891095c5c47e760f01b2cedaa214077414e3740dbc4d77967faf6732aa6`

实际截图：`output/workspace/0.6.2/packaged/`；文件夹验收：`output/folder-sidebar/packaged/results.json`。
