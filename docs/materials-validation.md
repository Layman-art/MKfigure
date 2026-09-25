# 输入资料专项验证

2026-09-16，在 Windows 上使用真实 Electron 主进程、正式 preload API 和正式导入/保存处理器完成。仅以 Playwright 替换原生文件选择对话框的返回值，没有替换资料提取逻辑。测试数据目录独立为 `.runtime/materials-smoke`；未调用 AI，未消耗模型额度，也未读取真实凭据文件。

## 已验证结果

| 项目 | 结果 |
| --- | --- |
| Chen 2018 Neural ODE PDF | 提取 44,333 字符，其中除页标记外正文 44,221 字符；连续标记 `[Page 1]` 至 `[Page 13]` |
| 参考图目录中的 overview.pptx | 提取 826 字符，其中除页标记外正文 816 字符；含 `[Slide 1]` |
| 原文件保护 | 两个源文件测试前后 SHA-256 相同；导入副本与源文件 SHA-256 相同 |
| 文档与图像角色 | PDF/PPTX 留在内容资料列表；上传风格参考只设置 `customReference`；复刻目标只设置 `target`，并进入复刻步骤；三者不会互相替换 |
| 移除后保存重开 | 使用实际“移除”按钮删除 PDF，等待自动保存，重载界面并重新打开项目；PDF 已移除，PPTX、风格参考和复刻目标均保留 |
| 路径限制 | 非法项目 ID 被拒绝；`saveProject` 不接受注入的新来源路径；非本次导出的文件不能通过 `revealFile` 打开 |
| 凭据返回 | 在独立测试目录中写入无效占位 Key，保存及 bootstrap 只返回 `hasKey`；未返回 Key 字段或明文；随后清除占位 Key |
| 页面错误 | 0 |
| AI 调用 | 0 |

PDF 的提示明确说明文字提取不等于完整阅读图表与公式；PPTX 的提示明确说明若作为视觉参考应另传 PNG/JPEG。这两项提示与实际行为一致。测试报告只记录字符数、页码标记、提示和哈希，不包含论文全文。

主进程源码检查同时确认：IPC 仅接收主窗口主 frame；renderer 未开放 Node；导入路径来自原生选择器；项目 ID 经校验，项目素材路径约束在项目目录；设置经白名单规范化，Key 由 Electron `safeStorage` 加密，公开设置不含私有加密字典。这是本次相关路径的检查，不等同于完整安全审计。

## 复现与证据

在项目目录运行 `node scripts/materials-smoke.mjs`。源 PDF/PPTX 路径在脚本中明确指定。测试会创建独立项目并保留验证资料副本，不会修改源文件。运行前应已经完成 `npm run build`。

- `output/materials-smoke/result.json`：实际结果、逐页标记与 SHA-256。
- `output/materials-smoke/after-remove-reopen.png`：移除 PDF 并保存重开后的界面。
- `scripts/materials-smoke.mjs`：测试入口。

最初运行因测试脚本等待“已保存”而界面实际为“已自动保存”产生超时；修正脚本定位器后完整重跑通过。未为此修改软件实现。

## 范围

本次覆盖 Windows 真实桌面的资料导入和项目保存路径，没有重跑通用离线导出检查。没有验证扫描 PDF 的 OCR，也没有验证 macOS 实机行为；本次 PDF/PPTX 仅提取文字，不自动渲染其中图表为风格参考。
