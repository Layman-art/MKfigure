# MK Figure 顶会论文图增补库

2.1 的六会 2026 增补库涵盖 137 篇论文、180 张编号原图。84 张来自带页码和坐标的 PDF，96 张按网页图源记录。合并保留的上游主图后，图库主图共 3,559 张，其中 867 张来自 2026 年。[图库交接](../../../docs/gallery-2.1.md)

| 会议 | 主图 | 算例结果 | 机理解释 | 算法 | 总计 |
| --- | ---: | ---: | ---: | ---: | ---: |
| AAAI 2026 | 11 | 4 | 1 | 2 | 18 |
| ACL 2026 | 19 | 3 | 1 | 2 | 25 |
| CVPR 2026 | 22 | 8 | 3 | 1 | 34 |
| ICLR 2026 | 21 | 5 | 2 | 2 | 30 |
| ICML 2026 | 23 | 4 | 2 | 1 | 30 |
| NeurIPS 2026 | 34 | 6 | 1 | 2 | 43 |
| 合计 | 130 | 30 | 10 | 10 | 180 |

主图取原文 Figure 1，其余图保留实际编号。同一图号下的面板合计一张。30 张会议算例中，纯二维 22 张、纯三维 5 张、两者兼有 3 张。

## 如何查回原图

- `paper` 是会议或出版方的论文页，`supplement.sourceUrl` 是支持其会议归属的论文页、日程、论文集或 DOI。本版 84 张增补图有指定 PDF 页与裁框，其余 96 张按公开的原图位置或多面板来源读取。网页锚点见 `figureUrl`，单图见 `supplement.imageSource`，多面板按 `imagePanels` 顺序读取。
- `pdf_source` 对应实际裁图文件。PDF 字节摘要为 `supplement.pdfSha256`，版本标记为 `supplement.pdfVersion`。如索引中同时提供 `publisherPdf`，可用该链接对照正式版；不同版本的页码和排版可能变化。`authors` 采用会议记录，若另有 `manuscriptAuthors` 则保留公开稿中的作者拼写。
- `page` 是 PDF 从封面起数的一基物理页号；`figure` 是该页的原文图号。`cropPdfPoints` 为 PyMuPDF 页面坐标的左、上、右、下，以左上角为原点，每点为 1/72 英寸。在相同 PDF 的该坐标区间可重新渲染，再对照 JPEG 检查图内标题、图例与轴标。裁切时可能裁掉空白及外部图注，原图注保留在原文。JPEG 的精确校验使用 `supplement.sha256`；不同 PDF 渲染器、输出倍率和压缩参数可能产生不同的 JPEG 字节。

## 如何维护

1. 为新增论文找到正式论文页或可核实接收身份的会议官方页面，并选择能公开复核的 PDF。保存作者、完整题名、来源、实际 PDF 版本及其 SHA-256。在基础库和增补库用题名、论文页、PDF 或海报编号检查重复与题名变体。
2. 打开实际 PDF，记录原图号码、一基物理页与裁框，导出为 JPEG，回看是否包含完整面板、内嵌标签、比例尺、坐标轴和图例。填写一条与本索引格式一致的记录，记录 JPEG 实际高宽与 SHA-256。主图填写 `main`，其余按图中实际内容填写 `result`、`mechanism` 或 `algorithm`。网页来源填写可定位到该图的网页、图号及实取图片地址；只有 PDF 裁图填写 PDF 页码与裁框。仅结果图填写 `dimensions` 和 `forms`。
3. ID 格式为 `mk-<小写会议><年份>-<论文键哈希前14位>-f<图号>`。从仓库校验脚本的 `paper_key` 得到规范化论文键，用 UTF-8 编码取 SHA-256。图片相对图库根目录的路径为 `supplement/images/<id>.jpg`。可参照相同会议中的现有记录。把新增 JPEG 与索引一起保存。
4. 在项目仓库根目录运行离线检查。完整图库检查需要 Python 和 Pillow，检查原 PDF 还需要 PyMuPDF。脚本可检查图片解码、哈希、尺寸、论文和图片去重、缺失文件、类别和图号；核对单份 PDF 时也检查原 PDF 哈希、图号文字与裁框边界。最后将原页与实际 JPEG 并排目视确认。

```sh
python scripts/import-gallery-supplement.py
python scripts/import-gallery-supplement.py --id mk-iclr2026-479c608c98a7e2-f5 --source-pdf path/to/DGNet.pdf
```

原刊对照示例可见 [ACL Anthology](https://aclanthology.org/volumes/2026.acl-long/)、[CVF Open Access](https://openaccess.thecvf.com/CVPR2026?day=all)、[ICLR 官网](https://iclr.cc/virtual/2026/poster/10009033)、[AAAI 出版记录](https://doi.org/10.1609/aaai.v40i25.39249)、[ICML 官方海报](https://icml.cc/virtual/2026/poster/63397) 和 [NeurIPS 官方海报](https://neurips.cc/virtual/2026/loc/sydney/poster/155294)。
