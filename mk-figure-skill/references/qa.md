# 检查与交付

只检查用户要求且实际生成的格式。结构检查通过不等于科学内容、显示和可编辑性通过；未完成的项写明待检查。

## 自动结构检查

下面的 `audit_figure.py` 适用于采用本科研图工作流默认中英文字体的 PPTX/SVG。若目标是高保真复刻已有 PPT/图片，字体要遵循目标参考而不是强套该脚本的字体约定；此时使用 [PPT QA 合约](ppt-qa-contract.md) 的 `audit_pptx.py`，按真实目标设置字体、文本和对象规则。若两种格式一起交付且采用默认科研图字体，仍可用 `audit_figure.py` 同时检查。工具选择以内容来源和约定字体为准。

```powershell
python scripts/audit_figure.py --pptx figure.pptx --svg figure.svg --output qa.json --expected-text-json labels.json
```

`--pptx` / `--svg` 至少提供一个，只交付一种格式时省略另一个。`--output` 必填；可选标签文件为字符串数组或 `{"labels": ["中文标签", "English label"]}`。脚本仅依赖 Python 标准库。

脚本检查 PPTX 的 ZIP/XML、必需包文件、画布、原生对象与图片、文字 run、OMML 和嵌入 SVG；检查 SVG 的命名空间、viewBox、画布、文字、矢量和外部图片/资源。它会拒绝只有图片的 PPTX 或只包装图片的 SVG，混合对象仍需人工确认编辑范围，不能用对象数作为还原度证据。

字体检查读取存储属性，支持 PPT 段落/列表默认值与无歧义主题、SVG 内联样式与继承。中文检查微软雅黑，英文检查 Times New Roman；未解析的母版/版式、SVG 样式表或实际字体替换不能靠此脚本判断，应显式设置 run/tspan 并检查渲染。

公式按本次选择的模式验收，不设跨任务通用的 OMML 数量要求。文字/矢量组件模式对照公式清单检查正斜体、上下标、分组和实际编辑性；PowerPoint Office Math 模式检查最终 PPTX 的 `a14:m` / `m:oMath`，保存重开后确认 `MathZones(1,1)`。SVG 可用 `data-role="math"` 或 math/formula/equation 类名标数学内容，正体文字标 `data-math-style="normal"`；只有明确识别的单字母变量才强制检查斜体。脚本记录粗体属性但不能根据目标图决定字重。

高保真 PPT 或高风险结构承诺按 [PPT QA 合约](ppt-qa-contract.md) 建立任务专用 JSON 规则，运行 `scripts/audit_pptx.py`。素材反复裁切时用 `scripts/crop_reference_assets.py` 检查原始边缘；局部修复用 `scripts/compare_pptx_semantics.py` 与 `scripts/compare_renders.py` 比较允许变化的对象和区域。Windows PowerPoint 可用时用 `scripts/render_powerpoint_native.ps1` 渲染最终文件。这些脚本分别检查不同性质的风险，不能以任一脚本的通过代替视觉验收。

标签检查在单个提取文字块内做忽略空白的子串匹配，没有 OCR 或公式等价性验证。退出码 1 表示明确错误；0 表示未发现明确错误，仍可能有 warning。报告的 `visual_review_required.status` 始终为 pending，实际验收另行记录，不改审计输出掩盖问题。

## 内容、显示与编辑检查

1. **科学内容**：对照来源核实文字、变量、单位、条件、公式和箭头；纠正伪字、伪公式和无来源数字，区分概念示意与实验结果。
2. **实际显示**：渲染保存后的最终文件，对照目标图查看全图和细节；双格式都渲染。检查换行、字号、遮挡、边缘裁切、基线、设备轮廓、箭头端点、线宽及颜色语义，并按最终论文插入尺寸检查可读性。
3. **字体**：中文微软雅黑及对应字重，英文 Times New Roman，公式变量斜体、其余按数学语义正体。观察实际渲染，不能只凭 XML 声明通过。
4. **编辑性**：在成品副本中改一处文字、移动一个独立图形、修改一个公式变量/上下标（若有），保存重开读回；SVG 重新解析并渲染。确认文字移走后无底图旧字，公式组合和内部组件均能修改。

PPT 优先用 PowerPoint 原生渲染；无 PowerPoint 时使用可用渲染器并写明未完成原生验证，SVG-only 不因此阻塞。只关闭本任务打开的文档，不退出用户已有 PowerPoint。修改后同步更新所需输出，复查受影响项及非目标区域是否变化。

## 记录与交付

简记各项通过、已修正或未完成，附成品、渲染器与预览路径。披露位图范围和编辑性限制；重复失败时保留产物与具体问题，不声称全流程通过。模型或推理强度变化不降低此标准。

过程文件留在任务目录；导出目录只放用户所选格式，不附送 JSON、源码或审计文件。需要复现时再提供原图、实际提示词、构建源码和检查记录。
