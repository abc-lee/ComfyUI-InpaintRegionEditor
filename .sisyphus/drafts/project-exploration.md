# InpaintRegionEditor 项目探测报告

> 探测时间：2026-02-28
> 探测模式：ULW 探测

---

## 一、项目概况

| 属性 | 详情 |
|------|------|
| **项目名称** | InpaintRegionEditor |
| **项目类型** | ComfyUI Custom Node |
| **许可证** | MIT |
| **主要功能** | 集成 Photopea 进行高级 inpaint 编辑，支持遮罩和选区 |

---

## 二、目录结构

```
E:\ComfyUI\custom_nodes\InpaintRegionEditor\
├── __init__.py              # 节点注册入口 (18 行)
├── nodes.py                 # 后端节点定义 (173 行)
├── README.md                # 项目文档
├── CHANGELOG.md             # 变更日志
├── DEVLOG.md                # 开发日志
├── LICENSE                  # MIT 许可证
├── .gitignore               # Git 忽略配置
│
├── web/                     # 前端扩展目录
│   └── extension.js         # 前端扩展入口 (301 行)
│
└── docs/                    # 文档目录
    ├── InpaintRegionEditor_Implementation_Plan.md  # 实现计划 (1190 行)
    └── plans/
        └── 2026-02-27-inpaint-region-editor-design.md  # 设计文档 (869 行)
```

---

## 三、核心文件分析

### 3.1 `__init__.py` - 节点注册入口

```python
from .nodes import InpaintRegionEditor

NODE_CLASS_MAPPINGS = {
    "InpaintRegionEditor": InpaintRegionEditor
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "InpaintRegionEditor": "Inpaint Region Editor"
}

WEB_DIRECTORY = "./web"
```

**关键点**:
- 注册了 `InpaintRegionEditor` 节点
- 指定了 `WEB_DIRECTORY = "./web"` 用于前端扩展

### 3.2 `nodes.py` - 后端节点定义

**节点功能**:
- 输入: 图像 + 选区尺寸预设/自定义尺寸
- 输出: image, mask, region_top, region_left, region_width, region_height

**核心概念**:
- **遮罩 (Mask)**: 定义重绘区域
- **选区 (Region)**: 定义参考区域
- **约束**: 选区必须 ≥ 遮罩

**预设尺寸**:
- 512×512 (SD)
- 768×768
- 1024×1024 (SDXL)
- 1280×1280
- 1536×1536

### 3.3 `web/extension.js` - 前端扩展

**核心模块**:

1. **PhotopeaBridge** - Photopea 通信桥接
   - `postMessage()` - 与 Photopea iframe 通信
   - `openImage()` - 打开图像到 Photopea
   - `exportImage()` - 导出图像
   - `exportSelectionAsMask()` - 从选区创建蒙版

2. **PhotopeaModal** - 全屏对话框 UI
   - 创建 Photopea iframe 模态框
   - 加载图像、保存图像/蒙版
   - 上传到 ComfyUI

**安全措施**:
- 消息来源验证 (`PHOTOPEA_ORIGIN`)
- 60秒超时处理

---

## 四、技术架构

```
┌─────────────────────────────────────────────────────────────┐
│                    ComfyUI 前端                               │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  extension.js                                           ││
│  │  ├── PhotopeaBridge (通信桥接)                          ││
│  │  └── PhotopeaModal (UI 模态框)                          ││
│  └─────────────────────────────────────────────────────────┘│
│                          ↕                                   │
│                   postMessage API                            │
│                          ↕                                   │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  <iframe src="https://www.photopea.com/">              ││
│  │  Photopea 完整应用                                       ││
│  │  - 液化、仿制图章等 PS 功能                               ││
│  │  - 选区/蒙版支持                                         ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
                          ↕
                   POST /upload/image
                          ↕
┌─────────────────────────────────────────────────────────────┐
│                    ComfyUI 后端                               │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  nodes.py - InpaintRegionEditor 节点                    ││
│  │  - 图像加载和处理                                        ││
│  │  - 遮罩边界计算                                          ││
│  │  - 选区位置计算                                          ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

---

## 五、工作流程

```
1. 用户添加 InpaintRegionEditor 节点
2. 上传图像
3. 右键 → "Open in Photopea"
4. 在 Photopea 中:
   a. 编辑图像（液化、仿制图章等）- 可选
   b. 用选择工具创建选区（作为蒙版区域）
5. 点击 "保存图像和蒙版"
6. 节点输出:
   - 编辑后的图像
   - 蒙版
   - 选区坐标 (top, left, width, height)
```

---

## 六、当前状态

### 已完成 ✅
- 基础架构：Python 后端 + JS 前端
- Photopea iframe 集成
- 图像加载和导出功能
- 右键菜单 → "Open in Photopea"
- 保存图像上传到 ComfyUI
- 从选区导出蒙版功能

### 待完善 🔧
- 图层蒙版导出优化（见 DEVLOG.md）
- 大图像性能优化
- 更多测试

### 已知问题 ⚠️
- Layer mask export script needs real-world testing
- Large images may have performance issues
- First Photopea load requires internet (~10MB)

---

## 七、依赖关系

### 后端依赖 (Python)
- torch
- numpy
- PIL (Pillow)
- folder_paths (ComfyUI 内置)

### 前端依赖 (JavaScript)
- ComfyUI 前端 API (`app`, `api`)
- Photopea (https://www.photopea.com/)

---

## 八、法律与合规

| 项目 | 状态 |
|------|------|
| Photopea API 使用 | ✅ 完全免费，可商用 |
| 作品归属 | ✅ 用户所有 |
| 标注要求 | ❌ 不强制（但推荐） |
| 广告 | ⚠️ 免费版会显示广告 |

---

## 九、参考资源

- Photopea 官网: https://www.photopea.com
- Photopea API 文档: https://www.photopea.com/api
- sd-webui-photopea-embed: https://github.com/yankooliveira/sd-webui-photopea-embed
- ComfyUI 前端仓库: https://github.com/Comfy-Org/ComfyUI_frontend

---

## 十、下一步建议

1. **测试完善**: 进行更多实际使用测试
2. **性能优化**: 大图像处理优化
3. **文档完善**: 用户使用指南
4. **发布准备**: 准备 ComfyUI Manager 发布

---

*报告生成时间: 2026-02-28*
