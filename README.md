# WhaleLife 图库 插件

独立本地图库：原图保存与去重、描述/标签/用途编辑、语义检索、GIF 保留、ZIP 备份、目录和 GitHub 图包导入。图片理解与 Embedding 模型由用户从主干配置中选择，默认不调用模型；不包含 QQ 或自主性实现。

## 使用与限制

在插件设置中明确选择图片理解模型和 Embedding 模型。上传/导入后点击“处理缺失的描述与向量”，任务可暂停、继续和重试。主模型明确收藏时自动生成描述与向量，普通收到图片只暂存引用，不自动永久收藏。

支持 PNG/JPEG/WebP/GIF，单文件上限 25 MiB、4000 万像素；保留 GIF 原字节，识图只采样部分帧。检索按用途和当前模型空间过滤后进行余弦比较。向量模型变化需要重新处理；本地精确扫描不承诺超大图库性能。

数据位于本插件 `data/`：原图、缩略图、SQLite、配置和待处理任务。停用/重启后未完成任务保持暂停。归档可恢复，ZIP 恢复会保留已有本地编辑。

公开模型工具：gallery_search、gallery_list、gallery_collect、gallery_manage、gallery_job、gallery_view。主模型直接查看原图受主干多模态工具能力限制，当前 gallery_view 会明确返回 multimodal_required；预处理识图不受影响。QQ 发图由 QQ 插件负责，图库只提供媒体服务。

接口见 [CONTRACT.md](CONTRACT.md)。不捆绑图集；图片来源与许可随用户数据保留，项目代码许可不替代图片许可。

## 开发与构建

需要 Node.js 24.22.1 或更新版本、Git。宿主与插件采用同级独立仓库，宿主只用于公开类型与隔离测试，不复制进插件发行包。示例从同一个空父目录开始：

```sh
git clone https://github.com/iinukami/whalelife.git
cd whalelife
npm ci
cd ..
git clone https://github.com/iinukami/whalelife-plugin-gallery.git
cd whalelife-plugin-gallery
npm ci --ignore-scripts
npm run build
npm run check
npm test
```

将 `dist/gallery/` 安装到宿主 `plugins/gallery/`。首次安装后启动宿主；升级保留已有 `data/`，不要覆盖用户配置。

测试只使用模拟模型/平台和隔离目录，不使用个人账号或正式记忆。兼容测试覆盖当前宿主及既有最低宿主基线；运行测试前须保留宿主 Git 历史。

## 发布与隐私

源码仓库不包含个人配置、凭据、会话记忆、日志、数据库、第三方运行包、node_modules 或构建产物。`.gitignore` 已排除这些目录；提交前仍需检查变更。

## 许可证

许可证待确定，当前仓库未添加项目许可证。第三方依赖沿用各自许可证。
