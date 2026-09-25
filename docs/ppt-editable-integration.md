# PPT-editable 合并说明

本仓库的 `mk-figure-skill/` 吸收了 [`Layman-art/PPT-editable`](https://github.com/Layman-art/PPT-editable) 的可编辑 PPT 工作方法和工具。合并依据为该仓库 `main` 分支的提交 `b4a672299b3b5aa35bf97e34bc303fecc22bfdc9`，原项目采用 MIT License，版权和许可证声明见原仓库。纳入本仓库的文件继续按 MIT 发布。

统一 skill 保留 MK Figure 的科研图生成、PPTX/SVG 复刻与科学内容核对，同时加入 PPT-editable 的视觉稿拆解、图片素材裁切、连接线与图层检查、原生 PowerPoint 渲染、语义差异比对和局部修复约束。仓库仅保留一个可安装的 skill 入口。

两套工作流对公式对象有不同默认值。跨 PPTX/SVG 的科研图复刻沿用可编辑文字、上下标与矢量线条；明确要求原生 PowerPoint 公式或进入 PPT 专项高保真模式时，使用 Office Math，并进行相应的原生公式检查。软件当前导出的公式使用前一种方式。skill 文案本身不改变软件运行逻辑，详见 [数据流](data-flow.md)。

原仓库的示例文件用于说明工作方法；本仓库不把示例图中的事实、坐标或字体设置当作新任务的默认科学内容。原 `PPT-editable` 仓库保留作为历史来源链接。
