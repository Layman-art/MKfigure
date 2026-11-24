# 版式推荐索引

本目录随 MK Figure 离线分发。MK Figure 从 Top-Conf Figure Gallery 的标题与摘要索引生成无位置倒排表。每个词或预设短语只关联出现过该词的论文编号，不存摘要、词序或原图。术语表和推荐算法由 MK Figure 编制。推荐理由中的词语描述论文文本，画廊的图型标签来自原记录。原作者、论文和 PDF 链接保存在桌面图库中。

- [上游索引与记录](https://github.com/qwdwqfwq/topconf-paper-figure-gallery/tree/b330dadd61612f6281052defe20181737397cd43/forge/data)
- [上游 MIT 许可证](https://github.com/qwdwqfwq/topconf-paper-figure-gallery/blob/b330dadd61612f6281052defe20181737397cd43/LICENSE)。该许可按原文适用于上游软件代码。论文与图片继续遵循各自来源的许可。
- [上游署名说明](https://github.com/qwdwqfwq/topconf-paper-figure-gallery/blob/b330dadd61612f6281052defe20181737397cd43/NOTICE.md)
- [论文图版权说明](https://github.com/qwdwqfwq/topconf-paper-figure-gallery/blob/b330dadd61612f6281052defe20181737397cd43/IMAGES_POLICY.md)

固定源提交为 `b330dadd61612f6281052defe20181737397cd43`。在 MK Figure 源码目录执行 `python scripts/build_layout_index.py <上游检出目录> resources/layout-index` 可重建数据。

MK Figure 增补条目按图号单独建索引，使用论文题名、该图的编目说明、类别、维度和图形标签。其原文位置见 [增补数据](../paper-gallery/supplement/figures.json) 中的论文链接、实际取图 PDF 和 PDF 页码。

期刊图以每个正式图号的记录 ID 为检索单位。构建器取题名、图级说明、期刊简称、主类别及已有的形式与维度，生成期刊专用压缩词表。一本期刊或一篇论文里的不同图可以返回不同的匹配理由。建议先看命中的图，再从原文图位检查数据与面板关系。[期刊构建脚本](../../scripts/build-journal-gallery.py) · [期刊图级清单](../paper-gallery/journals/figures.json) · [用户指南](../../docs/gallery-2.0.md)
