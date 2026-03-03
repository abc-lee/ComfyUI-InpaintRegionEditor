# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-03-03

### Added
- **选区调整大小**：拖动边缘/角落调整选区大小
- **光标变化**：移动、调整大小显示不同光标
- **Ctrl+V 粘贴**：支持直接粘贴图片到节点

### Changed
- **标签优化**："选区"改为"参考区"，字号缩小，像素数取整
- **图像尺寸显示**：左下角显示原图尺寸

### Fixed
- 光标设置被原生代码覆盖
- Ctrl+V 粘贴时系统创建新 LoadImage 节点

## [1.1.0] - 2026-03-03

### Added
- **选区约束**：选区必须框住蒙版且不能超出图像边界
- **MaskEditor 集成**：右键菜单 "Open in MaskEditor" 调用系统蒙版编辑器
- **自动约束**：padding 改变时自动调整选区位置和大小

### Changed
- **UI 简化**：移除红色蒙版区域显示（真实蒙版已在图像上可见）
- **约束逻辑**：统一 `constrainRegion()` 函数处理所有选区约束

### Fixed
- 变量名冲突导致 `nodeData.get is not a function`
- `app.commands` undefined → 使用 `app.extensionManager.command.execute()`
- MaskEditor 返回后双图像问题

## [1.0.0] - 2026-03-02

### Added
- **后端重构**：`padding` 参数替代 `region_size` 预设
- **蒙版错误处理**：无 Alpha 通道时抛出友好错误提示
- **选区坐标同步**：`region_coords` hidden widget 支持前端拖动
- **选区框 Canvas UI**：在节点上绘制遮罩（红色）+ 选区框（橙色虚线）
- **拖动交互**：支持鼠标拖动选区位置
- **Photopea 集成**：右键菜单 → 打开 Photopea 编辑
- **图像加载**：使用 `&channel=rgb` 获取纯 RGB 图像
- **图像导出**：PNG 格式导出并上传到 ComfyUI

### Changed
- 参数设计：`region_size/width/height` → `padding`（扩散像素数）
- 选区计算：固定尺寸 → 遮罩边界 + padding
- 错误处理：返回空蒙版 → 抛出 ValueError

### Technical Details
- **后端**：`nodes.py` - 蒙版提取 + 选区计算 + 坐标同步
- **前端**：`region-box-editor.js` - Canvas 绘制 + 拖动交互
- **前端**：`extension.js` - Photopea postMessage API
- **安全**：Origin 验证（仅接受 photopea.com 消息）

### Known Issues
- Photopea `layer.mask` API 返回 null（Issue #7341），无法直接导出图层蒙版
- 备选方案：用户上传带 Alpha 的 PNG 或使用选区 workaround
- 大图片（>2048×2048）可能导致 Photopea 卡顿
- 首次加载 Photopea 需要网络连接（~10MB）

## [0.1.0] - 2026-02-27

### Added
- Initial release
- Basic Photopea integration
- Mask loading/saving functionality

