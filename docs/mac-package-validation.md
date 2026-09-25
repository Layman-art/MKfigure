# macOS 分发包与验证范围

当前分发形式是可解压的 `MK Figure.app` ZIP，分别提供 Apple Silicon（arm64）和 Intel（x64）。这是真实应用 bundle，不是改扩展名的 DMG。Electron 44.4.1 的官方 `Info.plist` 要求 macOS 13.0 或更新版本。

解压对应架构的 ZIP 后，将 `MK Figure.app` 拖到“应用程序”。软件本身不依赖 PowerPoint；PowerPoint 仅用于开发期间检查 PPTX 的原生显示和编辑。

## 为什么采用手动封装

本次开发主机为 Windows。electron-builder 26.15.3 明确拒绝从 Windows 执行 macOS 构建，错误为 `Build for macOS is supported only on macOS`。因此依据 [Electron 官方手动打包规范](https://www.electronjs.org/docs/latest/tutorial/application-distribution)，使用官方 Darwin 预构建二进制，在 `Contents/Resources/app.asar` 中放入实际构建的应用，并按官方规范更新应用与 Helper 的 bundle 标识。

`app.asar` 经过检查，不含 `.node`、`.dll`、`.dylib` 或 `.exe` 平台依赖，因此其中的 JavaScript、前端资源和纯 JavaScript 依赖可共用。Codex 原生程序另外按 `mac-arm64` 和 `mac-x64` 分开装入。没有复制 Windows 可执行文件到 Mac 包中。

## 符号链接、权限与签名

- 每个 ZIP 保存 Electron 官方 14 个 framework Unix 符号链接及其相对目标，不把链接文本伪装成普通文件。
- 两份 Electron 预构建 ZIP 均核对 [官方 v44.4.1 SHA256 清单](https://github.com/electron/electron/releases/download/v44.4.1/SHASUMS256.txt)。
- ZIP 条目使用 Unix 属性；目录为 0755，Mach-O 程序和动态库为 0755，普通资料为 0644，符号链接为 0120777。
- Windows 的临时 staging 目录用 NTFS junction/hardlink 读取框架签名元数据，最终 ZIP 会恢复真正的 Unix 符号链接。没有修改开发者模式或系统权限。
- 使用上游 SHA256 校验过的 [rcodesign 0.29.0](https://github.com/indygreg/apple-platform-rs/releases/tag/apple-codesign%2F0.29.0)，为修改过的应用及 Helper 做本地 ad-hoc 签名。Intel 官方框架原本无签名，因此这些框架也执行本地 ad-hoc 签名。实现方式遵循 [rcodesign 官方签名说明](https://gregoryszorc.com/docs/apple-codesign/stable/apple_codesign_rcodesign_signing.html)。
- **没有 Developer ID 证书签名，没有 Apple 公证，没有上传到 Apple、GitHub 或 CI。** 签名工具使用明确的空配置，清除其专属环境变量，并禁用时间戳服务，不访问用户证书。
- Codex 0.154.0 的四个官方可执行程序保留原始字节，分别验证上游记录的 SHA256、对应 Mach-O 架构和可执行权限。

## 已执行的离线校验

打包脚本 `scripts/fix-mac-zip-permissions.py` 验证：

1. `Info.plist` 中的应用标识、版本、可执行文件与最低系统版本。
2. 实际 `app.asar` 的 SHA256，以及 `ElectronAsarIntegrity` 使用的 archive header hash。
3. 3 张参考图片、skill 资源、应用图标、Electron 许可证、Codex manifest 及对应架构程序均已包含；Codex 许可证分别核对记录的 SHA256。
4. 全部 framework symlink 目标可在 ZIP 内解析，无越界路径。
5. 每个 Mach-O 的架构与 Unix 0755 权限。
6. 本地 ad-hoc CodeDirectory 的逐页 SHA256，及 Info.plist、CodeResources、requirements 特殊槽哈希。
7. 应用资源签名清单中的文件 SHA256 和嵌套代码的 CodeDirectory hash。
8. ZIP CRC 全包完整性、条目无重复或路径越界，以及目录、普通文件、可执行程序、符号链接的 Unix 权限。

rcodesign 0.29.0 的 `verify` 对 ad-hoc 空 CMS 报出其自述的已知误报，日志保留在 `release-mac/logs/`。此外，处理原有 framework 时，它计算的部分嵌套 cdhash 与实际嵌入的 CodeDirectory 字节不一致；脚本以实际字节重新计算资源清单中的引用，然后重新签署外层可执行文件。本次使用独立的 CodeDirectory 与资源清单哈希核验；不会把这个过程描述为 Apple 原生 `codesign` 验证通过。

每个架构的完整结果位于 `release-mac/macOS-arm64-validation.json` 和 `release-mac/macOS-x64-validation.json`。包的 SHA256 以最终验证 JSON 为准。

## 本次最终构建

2026-09-16 重新封装的两份 0.1.0 分发包均已通过上述离线校验。两包内 `app.asar` 与最终 Windows 构建完全一致，SHA256 为 `c0ad0dfd3a36974e9a6524ef8f8ea7ee019c61555411947bbc4cf2782fd1051f`。

| 架构 | ZIP 文件 | 大小（字节） | SHA256 |
| --- | --- | ---: | --- |
| Apple Silicon | `MK-Figure-0.1.0-macOS-arm64.zip` | 260379041 | `332b32fdcc64aa1d7e037556a0e07cbebb58a16237fac9bb6c0e598ecf760346` |
| Intel | `MK-Figure-0.1.0-macOS-x64.zip` | 275797458 | `5e6601c841d3f070d57c6ca14483e935a3060c0c348589ed463f95807da80814` |

每包验证了 17 个 Mach-O 文件、14 个 framework 符号链接、32 个外层签名清单资源哈希和 8 个嵌套代码签名引用。arm64 对 5 个应用及 Helper 执行本地 ad-hoc 签名，x64 还包括 4 个原本未签名的框架，共 9 个实体；Codex 官方程序保持原始字节。

## 未验证内容

**尚未在真实 Mac 上启动、登录 Codex、调用模型或导出文件，也没有执行 Apple Gatekeeper、公证和原生 codesign 验证。** ZIP 结构与签名哈希通过，不等于 Mac 实机通过。首次打开可能遇到 macOS 对未公证应用的安全提示；面向正式公开发行前，仍需在两种 Mac 架构上测试并完成 Developer ID 签名、公证。
