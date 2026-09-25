# MK Figure 图标包

这里的 10 个 SVG 是 MK Figure 软件内置图标的原件，可直接下载、编辑或用于其他项目。所有图标与仓库源码一起按根目录 [MIT License](../LICENSE) 发布。

| 文件 | 内容 |
| --- | --- |
| `communication-tower.svg` | 通信基站 |
| `transmission-tower.svg` | 输电铁塔 |
| `person-yellow.svg`、`person-blue.svg`、`person-green.svg` | 三种颜色的人物 |
| `emergency-generator-truck.svg` | 应急发电车 |
| `electric-car.svg` | 电动汽车 |
| `mobile-storage.svg` | 移动储能 |
| `unmanned-vehicle.svg` | 无人载具 |
| `typhoon.svg` | 台风 |

`icon-pack/` 是原始文件目录。运行 `node scripts/prepare-library-assets.mjs` 会将图标逐字节复制到软件的 `resources/library/icons/`，并生成预览缩略图和 SHA-256 清单。软件内也可以从素材库保存原始 SVG。

图标来自项目所有者此前提供的城市防灾减灾矢量素材；来源记录见 [provenance.md](../resources/library/provenance.md)。
