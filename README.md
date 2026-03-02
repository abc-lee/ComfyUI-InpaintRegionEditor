# ComfyUI Inpaint Region Editor

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![ComfyUI](https://img.shields.io/badge/ComfyUI-Custom%20Node-blue.svg)](https://github.com/comfyanonymous/ComfyUI)

**增强版遮罩编辑器**：集成 Photopea 图像编辑 + 可拖动选区调整

> ⚠️ **开发中** | 本文档描述的是目标功能，当前版本功能有限
> 
> 📋 **完整技术文档**：见 [`docs/HANDOFF.md`](docs/HANDOFF.md)

---

## 📚 文档索引

| 文档 | 说明 | 目标读者 |
|------|------|---------|
| [`docs/QUICKSTART.md`](docs/QUICKSTART.md) | ⚡ 5 分钟快速开始 | 新接手开发的工程师 |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | 📋 完整交接文档 | 开发团队 |
| [`docs/implementation-plan.md`](docs/implementation-plan.md) | 💻 详细实现方案 | 后端/前端开发 |
| [`docs/technical-validation.md`](docs/technical-validation.md) | 🧪 技术验证清单 | 测试工程师 |
| [`DEVLOG.md`](DEVLOG.md) | 📔 开发日志 | 了解历史问题 |

---

## 🎯 功能特性

- 🎨 **Photopea 集成** - 完整的 Photoshop 级编辑功能（液化、仿制图章等）
- 📐 **可拖动选区** - 手动调整参考区域位置（不再只是中心扩散）
- 🔄 **自动蒙版检测** - 从 Alpha 通道提取，无蒙版时友好报错
- 🎭 **选区自动计算** - 选区 = 遮罩边界 + 扩散像素数

---

## 📦 安装

### 方法 1：ComfyUI Manager（推荐）

在 ComfyUI Manager 中搜索 "Inpaint Region Editor"。

### 方法 2：手动安装

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/YOUR_USERNAME/ComfyUI-InpaintRegionEditor.git
```

重启 ComfyUI。

---

## 🚀 使用方法

1. 添加 **Inpaint Region Editor** 节点
2. 上传图像（需要带 Alpha 通道的 PNG）
3. 右键点击节点 → **"打开 Photopea 编辑"**
4. 在 Photopea 中编辑图像和蒙版
5. 保存返回节点
6. 调整扩散像素数或拖动选区框
7. 执行工作流

---

## 📤 节点输出

| 输出 | 类型 | 说明 |
|------|------|------|
| `image` | IMAGE | 编辑后的图像 |
| `mask` | MASK | 局部重绘蒙版 |
| `region_top` | INT | 选区顶部坐标 |
| `region_left` | INT | 选区左侧坐标 |
| `region_width` | INT | 选区宽度 |
| `region_height` | INT | 选区高度 |

---

## 📘 核心概念

| 概念 | 目的 | 说明 |
|------|------|------|
| **遮罩 (Mask)** | 定义重绘区域 | AI 在这个区域内生成新内容 |
| **选区 (Region)** | 定义参考区域 | AI 参考这个区域内的原图内容 |

**约束**：选区必须 >= 遮罩

---

## ⚠️ 当前状态

### 已完成
- [x] 基础节点逻辑（`nodes.py`）
- [x] Photopea iframe 集成
- [x] 右键菜单打开 Photopea
- [x] 图像预览（自己渲染，不依赖 ComfyUI）
- [x] 选区框绘制（橙色）+ 遮罩区域显示（红色）
- [x] Alpha 通道自动检测蒙版
- [x] 选区框拖动功能

### 待完善
- [ ] 拖动体验优化（边界检测、视觉反馈）
- [ ] 图像缩放/放大查看
- [ ] Photopea 编辑后的图像刷新
- [ ] 完整工作流测试

---

## 🔧 技术细节

- 使用 Photopea [postMessage API](https://www.photopea.com/api/)
- 所有消息 origin 都经过验证（只接受 `https://www.photopea.com`）
- 图像处理在浏览器本地完成

---

## ⚡ 限制

- 需要网络连接（Photopea 从 CDN 加载）
- 首次加载约 10MB，之后缓存
- Photopea 无法通过脚本直接访问图层蒙版（官方 API 限制）

---

## 🙏 致谢

- [Photopea](https://www.photopea.com/) by Ivan Kutskir
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI)
- [ComfyUI-Impact-Pack](https://github.com/ltdrdata/ComfyUI-Impact-Pack) - 选区框实现参考

---

## 📄 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件。

### Photopea 使用条款
- API 完全免费，可用于任何目的（包括商业用途）
- 你的作品完全归你所有
- 无需标注使用了 Photopea（但建议标注）

---

## 📝 更新日志

详见 [CHANGELOG.md](CHANGELOG.md)。

---

*最后更新：2026-03-02*
