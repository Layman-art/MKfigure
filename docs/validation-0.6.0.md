# MK Figure 0.6.0 验证记录

日期：2026-10-18。源码目录：`D:\MKfigure\source`。安装验证未覆盖用户已安装的软件。

## 已实现

- 单图与并行创作独立入口，一个原生窗口中六个子窗，宽屏三列两行。
- 展开一图时其他任务继续；每图独立开始、停止及记录。
- 文件夹侧栏、最近目录、作品打开与删除，旧本地作品保留。
- 所选目录的 `.mkfigure/` 保存内容、资料副本、生成历史、可编辑场景和用量。复制整个目录后可重新打开。
- 统一风格与单图自定义/不用参考风格；每次调用保存风格快照；可选 AI 风格优化，用户应用后才修改描述。
- 单图内容/风格入口合并，视觉稿页不再重复上传参考；删除无意义的批量开始入口。
- Codex 0.163.0，账户模型目录缓存、6 小时刷新、启动/焦点/登录按需刷新，手动刷新不重置运行连接。
- 修复六路保存时 Windows 短暂文件锁、复制同 ID 工作区的隔离、旧子窗保存计时器，以及大图 PNG 截图裁剪。

## 实际验证

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| 构建与类型检查 | 通过 | `output/build-0.6.0.log` |
| 自动测试 | 158 项通过，2 项默认关闭的联网测试跳过 | `output/tests-0.6.0.log` |
| 六路 Workflow/IPC 并发 | 最大并发 6；单路取消剩余 5 路继续；风格覆盖/快照、刷新、关闭保存和失败恢复通过 | `output/panes/0.6.0/results.json` |
| 桌面 UI | 1440×900 三列两行；960 宽响应布局；展开保状态；0 前端异常 | `output/workspace/0.6.0/desktop/results.json` |
| Windows 包内程序 | 文件夹切换/取消/重开、未打开作品删除、复制同 ID 不同路径隔离通过 | `output/workspace/0.6.0/packaged/results.json` |
| 大尺寸 PNG | 五种横/竖尺寸，尺寸及四角像素均正确 | `output/render-regression/results.json` |
| 真实 GPT-6.1 Sol，低推理 | 风格建议 → 文字加风格直接生图 → 复刻 → 模型检查 → 三格式导出 → 重开全部通过 | `output/workspace/0.6.0/live/result.json` |
| 最终包导出 | SVG 与工作台同一场景；PNG 3548×1774；只选 PPT 时输出目录只有一个 PPTX | `output/workspace/0.6.0/live/packaged-result.json` |
| Microsoft PowerPoint 16.0 | 打开渲染、修改一个原生文本、保存重开后修改保留；原导出文件未改 | `output/workspace/0.6.0/live/powerpoint-check/result.json` |
| macOS arm64 / x64 | 架构、执行权限、14 个框架链接、Codex 官方哈希、资源封装及 ZIP CRC 通过 | `release-mac/macOS-0.6.0-{arch}-validation.json` |

六路并发测试使用本地可控模型替身，执行真实 Workflow 和 IPC；它证明本地并发隔离，不证明账户能持续承受六路云端请求。真实云端全流程使用一张简洁 Neural ODE 图，未将六张同时发给云端。

真实调用墙钟耗时：生图 35.5 秒、复刻 74.8 秒、检查 12.1 秒，另一次可选风格建议 8.6 秒。这是一例实测，不代表平均耗时或速度保证。所得场景 78 个原生对象，其中 42 个文本、36 个图形、0 位图；检查模型给出视觉通过并披露了柔和纹理改为纯色近似。此结果不代表所有复杂图、公式或低推理请求都能同样通过。

真实请求经 Codex 原生图像工具执行，未核实内部图像模型的具体名称。账户实际模型目录返回 7 个模型，包含 `gpt-6.1-sol`。

## 安装包

| 平台 | 文件 | SHA-256 |
| --- | --- | --- |
| Windows x64 | `release/MK-Figure-0.6.0-Windows-x64-Setup.exe` | `a460b9fa9f984b58f17b4badfa08f7b8e01facb455cd24627bc03c5f4960dffe` |
| macOS Apple Silicon | `release-mac/MK-Figure-0.6.0-macOS-arm64.zip` | `ee47de77161fe213eac46461931385abdb6d21f3b9434595cae4fa3fd89d6295` |
| macOS Intel | `release-mac/MK-Figure-0.6.0-macOS-x64.zip` | `685a2123170cc72f2bb11f022101478c389a06f0cca2ad04905b405b85d8cf61` |

三平台应用 ASAR 相同：`ed7a0081f50e7ff43e9a5fcab9afe71777529a193c4fd689fadf5b8a23652a84`。Windows 包内主进程与最终构建一致，归档未包含已知用户数据路径。

Windows 测试的是安装包所使用的完整包内程序，未运行安装向导覆盖现有安装。macOS 最低版本 13；已做本地 ad-hoc 签名和结构校验，**未做 Mac 真机运行测试、Developer ID 签名或 Apple 公证**。

## 截图

- `output/workspace/0.6.0/packaged/01-home.png`
- `output/workspace/0.6.0/packaged/03-six-images.png`
- `output/workspace/0.6.0/packaged/05-shared-style.png`
- `output/workspace/0.6.0/packaged/07-single-folder.png`
- `output/workspace/0.6.0/live/09-packaged-result.png`
- `output/workspace/0.6.0/live/powerpoint-check/powerpoint-render.png`

使用说明见 [workspaces-0.6.0.md](workspaces-0.6.0.md)。
