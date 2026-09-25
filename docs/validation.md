# MK Figure 0.1.0 验收记录

## 已验证

- TypeScript 检查与生产构建通过；36 项单元/协议/导出回归测试通过。默认测试另外跳过需明确开启的在线调用。
- Codex 官方 App Server 账户读取、动态模型列表、JSON 请求已真实通过。本机已有 CLI 0.151.0 与随包 CLI 0.154.0 均测试了实际连接；未复制 token 或修改全局配置。
- 真实应用已走通提示词、生图、可编辑复刻、检查、导出；另实际执行了一次精修和复核。生图收到原生 imageGeneration 完成事件及有效 PNG。
- 在线首版复刻出现公式间距、透明度/虚线等问题。图形格式兼容问题已修复并加入回归测试；精修后的视觉复核为 reviewed，但仍保留公式间距、曲线边界及简化还原提示。**这证明流程和检查可用，不证明任意图都能一次得到完美复刻。**
- 真正的 Electron 窗口测试了离线示例、3张内置参考、自定义参考上传、已有图片直达复刻、导出 PPTX/SVG/PNG、模型设置、密钥加密和非法路径拒绝。无页面错误。
- 实际停止操作约 288 ms 返回，未提交新输出、推进阶段或写入假成功记录。
- Windows PowerPoint 16.0 打开软件导出的样例成功，原生渲染与离线样例一致；在副本改变量、移动真实组合后保存重开通过。PPT 是原生文本/形状/曲线/组合，图片与 Office Math 均为0。
- 真实资料导入验证：13页 Chen Neural ODE PDF 提取44,221字符，参考 PPTX 一页提取816字符。页码/幻灯片标记正确，源文件与导入副本哈希一致。移除来源、保存、重载、重开均通过。
- API Key 在独立测试用户目录中验证了操作系统加密保存；界面只收到 hasKey，未返回明文。测试占位密钥已清除。
- 1100×800 和1440×960视口检查通过，无水平溢出。
- 所有 npm 依赖已锁定；已修复依赖审计发现的 image-size 与 esbuild 问题，最终审计无已知漏洞。

## 分发包

Windows 为 NSIS per-user 安装 EXE，macOS 为 Apple Silicon/Intel 的可安装 `.app.zip`。内置匹配架构的 Electron 与官方 Codex 0.154.0，不需要另装 Node.js、Python 或 PowerPoint。

macOS 在 Windows 主机上按 Electron 官方手动分发流程封装；保留 framework symlink、Unix 可执行权限，并作本地 ad-hoc 签名及 CodeDirectory/资源清单哈希验证。具体离线验证见 `mac-package-validation.md`。**未做 Developer ID 签名或 Apple 公证，也没有 Mac 实机运行验收。** 本地 ad-hoc 与离线校验不等同于 Apple 签名、公证或 Gatekeeper 原生验证。

## 尚未验证或不保证

- OpenAI / DeepSeek / 自定义 API 使用本地模拟 HTTP 服务验证协议、错误和取消；本次未提供相应付费 Key，未做真实付费 API 调用。
- 官方浏览器登录流程已实现，协议已测；未把现有账户登出再做全新 OAuth 登录。
- Codex 图像工具没有返回可确认的底层图像模型，不能宣称锁定 Image 2.5；API 模式才支持显式图像模型 ID。
- macOS 未实机启动、登录或导出；字体依赖安装环境。程序会提示未检测到的默认字体，商业字体不随包分发。
- PDF/PPTX 导入是文字提取，不是完整图表/公式 OCR；扫描PDF需补充页面图片或文字。
- 模型复刻质量、科学正确性仍需要对照来源检查；自动检查不作研究结论保证。

## 证据位置

- `output/smoke/results.json`：桌面 UI、导出与密钥保存。
- `output/live-workflow/result.json`：原在线全流程和首次视觉问题。
- `output/quality-finish/result.json`：精修、复核、取消及视口。
- `output/materials-smoke/result.json`：资料导入、保存重开和源文件保护。
- `output/native-qa/summary.json`：PowerPoint 原生检查。
- `release-mac/macOS-*-validation.json`：Mac bundle 离线验证。

尚未进行全面第三方安全审计，也没有向 GitHub、Apple 或任何 CI 上传源代码或分发包。
