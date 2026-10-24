# 仓库首页截图

基础截图来自 MK Figure 0.6.0 实际 Windows 程序。`hnsse-method-preview.png` 和 `imu-joint-angle-preview.png` 为局部替换画布内容的展示合成图，其余截图未经合成或重绘；具体来源见下表。

| 文件 | 来源 | 说明 |
| --- | --- | --- |
| `six-pane-workspace.png` | `output/workspace/0.6.0/packaged/03-six-images.png` | 载入参考素材展示六窗布局，不表示六图由云端同时生成。 |
| `creation-home.png` | `output/workspace/0.6.0/packaged/01-home.png` | 单图、并行及文件夹入口。 |
| `shared-style.png` | `output/workspace/0.6.0/packaged/05-shared-style.png` | 公共风格设置。 |
| `folder-workspace.png` | `output/workspace/0.6.0/packaged/07-single-folder.png` | 测试文件夹中的单图工作区。 |
| `editable-export.png` | `output/workspace/0.6.0/live/09-packaged-result.png` | GPT-6.1 Sol 低推理真实流程产生的 Neural ODE 可编辑结果。 |
| `hnsse-method-preview.png` | 在 `editable-export.png` 的右侧画布内替换科研图，2026-10-19 | 作者提供的 `HNSSE_方法图_v1.pptx` 第一页经 PowerPoint 导出，再等比例嵌入原截图的 `(1080, 380, 650, 361)` 像素区域。画布替换区域外像素完全不变；项目名称、元素数量、运行数据仍属于原 Neural ODE 示例，不代表 HNSSE 的生成、复刻或导出验证。 |
| `imu-joint-angle-preview.png` | 在 `editable-export.png` 的右侧画布内替换科研图，2026-10-24 | 用户提供的 `网络结构图_公式与弧线修正版.png`，按原比例缩放并以白底嵌入 `(1080, 380, 650, 361)` 像素区域。已逐像素验证区域外与原截图及此前 HNSSE 展示图一致；项目名称、元素数量、运行数据仍属于原 Neural ODE 示例，不代表此网络图的生成、复刻或导出验证。 |

网络图来源说明：该图为根据用户上传图片制作的复刻案例，历史记录显示其可编辑版本于 2026-09-05 完成公式样式与弧线修正。整图的原始论文、作者及图号尚未核实，不能据此声明模型原创或推定文献归属。

测试范围见 [0.6.0 验证记录](../validation-0.6.0.md)，截图中的参考素材来源见 [provenance.md](../../resources/library/provenance.md)。截图不包含登录凭据或用户研究文件路径。
