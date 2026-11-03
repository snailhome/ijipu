# 乐谱库（scores-library）

这里放**已发布的乐谱**，每首一个目录。站点构建（`scripts/gen-scores.mts`）会递归扫描它，
和 `public/scores/` 合并后生成 `dist/scores/`。

```
scores-library/
├── <slug>/
│   ├── score.jps      # 必需
│   ├── meta.json      # 必需（格式见 docs/SCORE-PKG.md）
│   ├── assets/        # 可选：背景/水印/封面
│   └── README.md      # 可选：给人看
├── _inbox/            # 拖进来的 zip（管理工具导入后移走）
├── _packages/         # 导出的 zip（分享/备份）
└── _trash/            # 下架/删除归档
```

- 允许再建子目录做**存放分组**（如 `collections/民歌/<slug>/`），但**站点分类只认 `meta.tags`**；
  子目录只是本地收纳，扫描会递归。
- `_` 开头的目录不参与构建。
- 目录名必须等于 `meta.slug`；`slug` / `short` 全局唯一。
- 标签 `示例谱` 是保留 tag，后续用于首页示例（见 `docs/SCORE-PKG.md` §5.2）。
- 现在 `public/scores/` 里还有 8 份旧内容；迁移完成前两边合并，新内容只放这里。

规范全文：`docs/SCORE-PKG.md`。
