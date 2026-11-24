# MK Figure 2.0 论文图库交接

想学一篇论文怎样组织从问题到方法的叙述，打开“论文主图”。想画自己的仿真结果、解释机理或标出算法步骤，打开对应的会议或期刊正文图库。先看作者用哪些面板支持同一个结论，再决定自己的数据和方法适合怎样排版。

## 收录范围与计数

| 入口 | 2.0 收录 | 适合查什么 |
| --- | ---: | --- |
| 论文主图 | 3,525 | AAAI、ACL、CVPR、ICLR、ICML、NeurIPS。上游 3,449 张，加 MK Figure 补录的 76 张。2026 年共有 818 张。 |
| 顶会算例与方法图 | 56 | 六会 2026 年正文中的 36 张算例结果、10 张机理解释、10 张算法图。 |
| 期刊算例与方法图 | 5,391 | 19 刊、1,683 篇论文，共 3,057 张算例结果、1,240 张机理解释、1,094 张算法图。 |

期刊图覆盖 2017–2026 年，其中 2022–2026 年有 4,464 张，占 82.80%。一篇可有多图，同一正式图号下的多个面板合计一张。一次查询可交叉期刊、年份、主题与图形条件。“跨刊浏览”适合先比较不同学科的图法。期刊名称、每刊数量和每个标签的实数可在随版统计中复核。[年度会议增补](../resources/paper-gallery/supplement/README.md) · [期刊统计](../resources/paper-gallery/journals/coverage.json)

## 看图与选图

1. 在算例与方法图库选择 **Experimental results**（算例结果图）、**Mechanism explanations**（机理解释图）或 **Algorithms**（算法图）。判断对象是该图实际讲了什么。同一篇点云论文的网络架构可以归算法，比较不同模型分割表现的多面板归算例。
2. 结果图再选 **2D**、**3D** 或 **Mixed 2D and 3D**。期刊库中三者分别有 2,936、75、46 张。纯二维曲线可报告三维任务的指标；只有实际展示了三维几何、点云、曲面或体信息的面板才构成三维展示。维度互斥，同一图的表现形式可多选，所以不能把形式计数直接相加。
3. 进入详情放大，确认原论文、作者、图号和图例。PDF 图按记录的实际版本打开相应物理页；HTML 图用“原文图位”直达图号。收藏供稍后对照，或在创作页的“从图库选版式参考”选择最多三张。分享时复制图链，对方在相同版本图库粘贴即可定位。
4. 写清借哪一层。例如“第一行统一色标画误差场，第二行在同一截面叠加实测与预测”。在自己的论文里重算数值、换上本研究的变量，并核对图例及单位。将实测或仿真的图作为内容参考；选择“读参考图细化版式”或提交生图时，选中的版式参考像素会发送至当前模型。

## 可复查的原图实例

| 原文与位置 | 原图展示与可借鉴之处 |
| --- | --- |
| *MHopReg: Efficient Hierarchical Multi-Hop Graph Search for Point Cloud Registration*，CVPR 2026，Figure 3 | 横排复用同一对点云，逐步叠加种子、邻居与对应连线。解释迭代算法时可固定坐标和对象，只在每步突出变化。[正式 PDF 第 7 页](https://openaccess.thecvf.com/content/CVPR2026/papers/Wu_MHopReg_Efficient_Hierarchical_Multi-Hop_Graph_Search_for_Point_Cloud_Registration_CVPR_2026_paper.pdf#page=7) |
| *Global Attention-Guided Dual-Domain Point Cloud Feature Learning for Classification and Segmentation*，IEEE Transactions on Artificial Intelligence，Figures 1 与 4 | Figure 1 从点云输入分出两路特征流，箭头指出全局注意力进入哪里。Figure 4 用物体作列、方法作行，在同一物体各行沿用部件色标。两图可分别借鉴分支回注和多方法几何对照。[算法图](https://arxiv.org/html/2407.08994v1#S3.F1) · [分割结果图](https://arxiv.org/html/2407.08994v1#S4.F4) |
| *Physics-informed machine learning-based real-time long-horizon temperature fields prediction in metallic additive manufacturing*，Communications Engineering，Figure 4 | FEM 温度场预测将空间分布与曲线比较置于同一图号。做热场对照时，可用共同色标对齐空间面板，并在其旁放代表位置的定量变化。[原图与图注](https://pmc.ncbi.nlm.nih.gov/articles/PMC12479805/#Fig4) |
| *A New Neural Network Paradigm for Scalable and Generalizable Stability Analysis of Power Systems*，IEEE Transactions on Power Systems，Figure 9 | (a)–(d) 展示不同截面的能量函数曲面，(e)–(h) 比较估计吸引域。画稳定域时可对应排列同一工况的曲面和二维边界，让上下面板逐列可比。[作者公开版 Figure 9](https://arxiv.org/html/2510.25501v1#S5.F9) |

## 已收录的 53 种英文结果标签

下表来自本版期刊入库统计，英文与界面一致。一次筛选后计数为零的选项不可选。[标签定义](../src/shared/gallery-taxonomy.ts) · [逐项图数](../resources/paper-gallery/journals/coverage.json)

| 中文 | English | 本版期刊图数 |
| --- | --- | ---: |
| 曲线图 | Line plot | 1,587 |
| 多面板联图 | Multi-panel comparison | 677 |
| 柱状图 | Bar chart | 439 |
| 时序响应 | Time series | 399 |
| 热图 | Heatmap | 371 |
| 散点图 | Scatter plot | 362 |
| 分布图 | Distribution | 268 |
| 空间场 | Spatial field | 254 |
| 定性对照 | Qualitative comparison | 221 |
| 情景对照 | Scenario comparison | 210 |
| 地理地图 | Geographic map | 131 |
| 灵敏度分析 | Sensitivity analysis | 114 |
| 堆叠对照 | Stacked comparison | 102 |
| 点估计与区间 | Point and interval plot | 101 |
| 频谱与时频谱 | Spectrum and spectrogram | 99 |
| 不确定性区间 | Uncertainty interval | 89 |
| 相轨迹与路径 | Phase trajectory and path | 78 |
| 箱线图 | Box plot | 76 |
| 密度图 | Density plot | 59 |
| 三维曲面 | 3D surface | 57 |
| 网络拓扑 | Network topology | 49 |
| 直方图 | Histogram | 48 |
| 预测与实测对照 | Predicted versus observed | 46 |
| 小提琴图 | Violin plot | 43 |
| 可行域与稳定域 | Feasible and stability region | 42 |
| 时空演化 | Spatiotemporal comparison | 42 |
| 嵌入投影 | Embedding projection | 25 |
| 等值线 | Contour plot | 23 |
| 占比与环形图 | Pie and donut chart | 23 |
| 消融比较 | Ablation comparison | 22 |
| 残差图 | Residual plot | 22 |
| 雷达图 | Radar chart | 16 |
| 混淆矩阵 | Confusion matrix | 14 |
| 极坐标图 | Polar plot | 14 |
| 累积分布 | Cumulative distribution | 11 |
| 流量与桑基图 | Flow and Sankey diagram | 11 |
| 网格 | Mesh | 11 |
| 点云 | Point cloud | 10 |
| 龙卷风图 | Tornado chart | 9 |
| 帕累托前沿 | Pareto frontier | 8 |
| 森林图 | Forest plot | 6 |
| 矢量场 | Vector field | 6 |
| 瀑布图 | Waterfall chart | 6 |
| 体绘制 | Volume rendering | 5 |
| 山脊分布图 | Ridgeline plot | 4 |
| 三维柱状图 | 3D bar chart | 3 |
| 弦图 | Chord diagram | 2 |
| 三元图 | Ternary plot | 2 |
| 马赛克图 | Mosaic plot | 1 |
| 平行坐标 | Parallel coordinates | 1 |
| ROC 与精确率召回率 | ROC and precision–recall curves | 1 |
| 矩形树图 | Treemap | 1 |
| 风玫瑰图 | Wind rose | 1 |

## 原图溯源和权利

每条期刊记录包含题名、作者、出版年、期刊、DOI、正式图号和该图的简义。PDF 来源附实际取图文件、从 1 开始的物理页与裁框，作者稿与出版版本的页码可能不同。网页来源保留能定位正式图号的链接、单图地址或有顺序的面板地址，可以没有页码。正文可公开阅读、个人缓存和再次公开分发是不同用途。再用某一幅原图时，检查该图的署名、图注中的第三方材料说明及论文许可。开放图包逐文件列出来源与许可。[期刊记录](../resources/paper-gallery/journals/figures.json) · [第三方声明](../resources/THIRD_PARTY_NOTICES.md)

## 本机离线与公开安装

| 使用情形 | 图像从哪里来 | 如何核对 |
| --- | --- | --- |
| 已配完整图像库的本地工作站 | 所有已部署图像均从本机读。检索、推荐、浏览分开运行。 | 断网重启，确认“本机离线可用”覆盖所需记录，并放大大图。 |
| 默认公开安装 | 索引在本地。固定上游主图按哈希取原件，期刊开放图优先按字节区间取 ZIP 中的一张；其余增补图使用登记的公开网页图源、有次序的多面板或 PDF 页与裁框。 | 首次缺图须联网。缓存完成后断网重启，打开相同图号验证。出版社限流或文件换版时，可打开“原文图位”或稍后重试。 |
| 携带开放图包 | “安装开放图包”可校验并导入同版本 ZIP 的 817 张期刊开放图。“缓存顶会主图”单独处理可批量缓存的上游主图。 | 检查已校验数量，再打开本次研究所需的代表图。 |

全部 5,391 张期刊图在备好的显示分辨率下，编码优化前为 1,238,295,600 字节，优化后为 1,025,976,559 字节，减小约 17.1%。这个比较针对相同分辨率的解码像素；从出版原图生成展示裁片还包含选区、留白处理或缩放。开放预览共 13,954,058 字节，独立 ZIP 为 151,520,328 字节。这些数字分别衡量图像、预览与公开图包，整套应用还包括运行时和其他资源。[构建与压缩脚本](../scripts/build-journal-gallery.py)

## 交接与验收

- **记录与像素**　 从来源定位正式图号，再核对面板顺序、图例、坐标轴、比例尺和小字的清晰程度。DOI 与图号组合去重，再检查相同字节和近似裁图。存档条目校验 SHA-256。由公开图源重新渲染的图按自身摘要缓存；不同的 PDF 渲染器可以生成不同的像素或编码字节。
- **编辑复核**　5,504 张期刊候选经查重与筛选后收录 5,391 张。第一轮独立抽查覆盖 290 张，对错类、标签、说明及裁框进行修订。另对 562 张只有“定性对照”标签的参考图逐幅查看，为其中 526 张细化了图形标签，将 2 张阈值或积分原理示意归入机理解释，剔除版式重复或辨识度偏低的 29 张。检查最短的图注时，再为 13 张图补写图面说明，例如并列时域波形和频谱的电网振荡案例。最终入库中有 850 张换用经核对的同版本 PDF 或出版社原生高清图。定向抽查的缺陷比例不能外推到全库。
- **干净公开安装**　 选三个入口各一张图，核对元数据与大图，再检查同篇不同图号、混合维度和零计数选项。打开出处验证图号，保存项目后重新打开，检查引用仍保留图号及已有页码。单独测试直接图片、多面板和 PDF 裁切来源；缓存后断网重启，再验放大图。
- **更新快照**　 同步替换刊物目录、统计、图级索引、开放预览与图包。校验图包中的每条已登记字节范围和对应 SHA-256，核对 ZIP 中 `CREDITS.json` 与当版条目一致。项目自己的本地全量缓存与可公开分发的开放图包分别管理。[缓存实现](../src/main/gallery-cache.ts) · [检索来源](../resources/layout-index/SOURCE.md)
