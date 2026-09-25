# 精修、取消与界面验收记录

日期：2026-09-16。此记录对应开发构建 `0.1.0` 的应用功能验收；安装包启动与 macOS 平台验证另有记录。

## 执行范围

- 使用 `.runtime/live-workflow` 内已有的 `Live Neural ODE test` 项目与已生成目标原图。
- 通过应用公开 IPC 调用 Codex `gpt-5.5`，推理强度 `low`，执行一次 `refine` 和一次 `review`，没有再次生成图片。
- 使用真实 Electron 窗口，在 1100 × 800 和 1440 × 960 两种内容区域尺寸检查生成与精修页面。
- 通过真实界面发起一次模型提示词整理请求，再点击「停止」。
- 证据目录：`output/quality-finish/`；可复现脚本：`scripts/refine-workflow-smoke.mjs`。脚本要求显式设置 `MK_LIVE_E2E=1`，会调用当前已登录 Codex 账户的额度。

## 结果

| 检查项 | 观察结果 |
| --- | --- |
| 精修调用 | 完成，123 个元素调整为 125 个；原始目标图片 ID 与生成图片数量均保持不变 |
| 结构检查 | 通过；50 个文字组件，75 个矢量图形，0 个位图对象 |
| AI 视觉检查 | 首次为 `failed`；精修后的本次复核为 `reviewed`，但保留公式间距和还原度提示 |
| PPTX / SVG / PNG 导出 | 完成，并保存对应 scene / qa JSON |
| PPTX 内部结构 | 50 个文字 run，0 个 Office Math、0 个 picture 对象、0 个媒体文件；文字字体均为 Times New Roman |
| 停止请求 | 点击停止后约 288 ms 返回「已停止本次操作」；项目仍为 brief，提示词和资料笔记为空，未添加 prompt/analyze 成功历史 |
| 1100 × 800 与 1440 × 960 | 检查页和生成页均无水平溢出；长内容正常纵向滚动；参考图库、阶段导航、提示词框和预览可用 |
| 渲染器异常 | 本轮未捕获 pageerror |

取消测试验证了应用请求被中止、状态未被错误提交；本轮没有另行审计服务端计费或推理是否在取消前已经开始。

## 尚存问题与边界

1. 精修后的 `x(t_0)`、`x(t_1)`、`f_theta(x,t)` 仍有偏大的视觉间距。模型本轮判为 warning；人工对照也可见公式字符与下标位置尚不够紧凑，不能据此宣称已达到投稿级数学排版。
2. 面板投影有所恢复，但背景、曲线和比例仍比目标图简化。此测试证明真实精修与检查链路工作，不证明任意参考图均可逐像素复刻。
3. `curve.band` 和 `curve.orange` 保留 `PATH_LOCAL_BOUNDS` 警告；目前实际 SVG 预览的曲线位于画布内，导出成功，但警告未被静默清除。
4. 本轮检查了实际 SVG/PNG 显示和导出 PPTX 的对象结构；没有在 PowerPoint 中重开这份精修导出并逐项编辑，也没有在 macOS 运行。
5. AI 视觉复核为辅助检查。即使状态为 `reviewed`，残留 warning 仍在界面与 qa 文件中显示，不能将其等同于科学与视觉内容无条件通过。

## 主要证据

- `output/quality-finish/result.json`：完整运行、取消、视口与导出结果。
- `output/quality-finish/before.png` 与 `after.png`：精修前后可编辑渲染。
- `output/quality-finish/before.qa.json` 与 `after.qa.json`：问题变化。
- `output/quality-finish/refine-feedback.txt`：实际发送的精修意见。
- `output/quality-finish/review-after-1100x800.png` 与 `review-after-1440x960.png`：检查页实际界面。
- `output/quality-finish/visual-stage-1100x800.png` 与 `visual-stage-1440x960.png`：参考图选择和可编辑提示词实际界面。
