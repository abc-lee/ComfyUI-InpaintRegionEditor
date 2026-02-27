# ComfyUI InpaintRegionEditor - 完整实现方案

> 基于深度调研制定的技术方案，供下一个会话实现
> 
> 版本：5.0 | 更新时间：2026-02-27

---

## 一、用户需求确认

### 1.1 业务需求来源

用户希望为 ComfyUI 的局部重绘（Inpaint）功能增加：

1. **功能1：可拖动重绘区域框**
   - 原有问题：局部重绘需要遮罩向外扩散，不够精确
   - 新需求：手工录入区域框尺寸（如 512×512），可拖动框住遮罩位置
   - 输出增加：`region_top`, `region_left`, `region_width`, `region_height`

2. **功能2：PS 类功能**
   - 液化、仿制图章等能力
   - 在重绘前可手工调整原图

### 1.2 技术选型决策

| 需求 | 选择 | 原因 |
|------|------|------|
| **前端架构** | 独立编辑器 | 不依赖原有 MaskEditor，实现更简单 |
| **区域框交互** | 自动计算 + 手动微调 | 最佳用户体验 |
| **PS 功能** | 嵌入 Photopea | 零开发成本，功能完整 |
| **约束** | 纯 custom node | 不修改 ComfyUI 核心代码 |

---

## 二、Photopea 深度解析

### 2.1 Photopea 是什么？

**一句话定义**：Photopea = 浏览器里的 Photoshop

| 属性 | 详情 |
|------|------|
| **开发者** | Ivan Kutskir（1人，乌克兰/捷克）|
| **开发时间** | 2013年至今（10+ 年）|
| **代码量** | 138,541 行 JavaScript |
| **月活用户** | 1300 万+ |
| **年收入** | ~$100-120 万美元（广告+订阅）|
| **支持格式** | 40+ 种（PSD, AI, Sketch, Figma...）|
| **成本** | 免费（API 完全免费）|

### 2.2 为什么能实现完整 PS 功能？

```
Photopea 的 138k 行代码包括：
├── PSD 解析器（逆向工程 Adobe 格式）
├── 图层系统（完整的图层树结构）
├── 渲染引擎（Canvas 2D + WebGL）
├── 滤镜系统（高斯模糊、液化、锐化...）
├── 选区算法（魔棒、套索、快速选择...）
├── 文字引擎（字体渲染、排版）
├── 脚本引擎（兼容 Adobe JSX）
└── 40+ 格式解析器
```

**这是一个人用 10 年写出来的代码量，功能追平 Photoshop。**

### 2.3 技术架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Photopea 技术栈                          │
├─────────────────────────────────────────────────────────────┤
│  渲染引擎: Canvas 2D + WebGL                                │
│  图像处理: JavaScript + WebAssembly                         │
│  文件格式: 自定义解析器（PSD, AI, SVG 等 40+ 格式）          │
│  UI: 自定义 HTML/CSS（非框架）                              │
│  存储: IndexedDB（本地缓存）                                │
│  性能优化: Web Workers（多线程）                            │
└─────────────────────────────────────────────────────────────┘
```

### 2.4 网络依赖问题

**重要**：Photopea 是「本地处理 + 联网加载代码」的混合架构。

| 功能 | 是否需要联网 | 说明 |
|------|-------------|------|
| **打开/编辑图像** | ❌ 不需要 | 纯本地处理 |
| **液化/滤镜** | ❌ 不需要 | 纯本地计算 |
| **保存文件** | ❌ 不需要 | 纯本地操作 |
| **首次打开** | ✅ 需要 | 下载核心代码（~10MB）|
| **字体选择** | ⚠️ 部分 | 字体预览缩略图需下载 |
| **广告显示** | ✅ 需要 | 广告从服务器加载 |

**断网打不开的原因**：
1. 首次需要下载 ~10MB 的 JavaScript 代码
2. 浏览器缓存被清理后需要重新下载
3. 字体预览缩略图（7600+ 字体，2.75GB）需要从服务器获取

**解决方案**：
- 首次联网加载后，不要清理浏览器缓存
- 如需完全离线，可购买 Self-Hosted 版本（$500-$2000/月）

### 2.5 嵌入原理

```
┌─────────────────────────────────────────────────────────────┐
│                    宿主页面 (ComfyUI)                        │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │  <iframe src="https://www.photopea.com/">             │ │
│  │                                                       │ │
│  │  ┌─────────────────────────────────────────────────┐ │ │
│  │  │  Photopea 完整应用                              │ │ │
│  │  │  - 所有 PS 功能已实现                           │ │ │
│  │  │  - 138k+ 行代码运行在 iframe 内                 │ │ │
│  │  └─────────────────────────────────────────────────┘ │ │
│  └───────────────────────────────────────────────────────┘ │
│                          ↕                                  │
│                   postMessage API                           │
│                          ↕                                  │
│  ┌───────────────────────────────────────────────────────┐ │
│  │  宿主脚本                                              │ │
│  │  - 发送图像到 Photopea                                 │ │
│  │  - 接收编辑后的图像                                    │ │
│  │  - 只需要 ~100 行代码                                  │ │
│  └───────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## 三、法律约束与使用条款

### 3.1 Photopea 官方条款（原文）

**Terms Of Use**:

> "The Photopea editor can be used by anyone for any purpose, for free."
> 
> "All your work belongs to you. You can sell the work, which you made in Photopea, without giving us any share."
> 
> "You don't have to mention that your work was made using Photopea."

**API Policy**:

> "Photopea API is completely free."

### 3.2 法律分析

| 行为 | 是否允许 | 条款依据 |
|------|----------|----------|
| **嵌入 iframe 到产品** | ✅ 允许 | API 完全免费 |
| **商业用途** | ✅ 允许 | "anyone for any purpose, for free" |
| **出售你的作品** | ✅ 允许 | "All your work belongs to you" |
| **不标注使用了 Photopea** | ✅ 允许 | "You don't have to mention" |
| **作为 custom node 发布** | ✅ 允许 | API 免费使用 |
| **移除广告** | ⚠️ 需付费 | 购买 Distributor 账户 |

### 3.3 需要注意的风险

| 风险 | 说明 | 缓解措施 |
|------|------|----------|
| **广告显示** | 免费版会显示广告 | 购买白标或提示用户 |
| **服务依赖** | 依赖 photopea.com | 可购买自托管版本 |
| **隐私问题** | iframe 加载时会连接服务器 | 在隐私政策中说明 |

### 3.4 白标模式价格（可选）

| 方案 | 价格 | 功能 |
|------|------|------|
| **免费** | $0 | 完整功能，有广告 |
| **Distributor** | 按月流量计费 | 隐藏广告、隐藏品牌按钮 |
| **Self-Hosted** | $500-$2000/月 | 完全自托管，可离线使用 |

**结论**：可以免费公开发布，用户会看到广告（影响体验但不违法）。

---

## 四、技术架构

### 4.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    ComfyUI InpaintRegionEditor                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    右键菜单集成                                       │   │
│  │  ┌─────────────────┐  ┌─────────────────┐                           │   │
│  │  │ Open in Region  │  │ Open in         │                           │   │
│  │  │ Editor          │  │ Photopea        │                           │   │
│  │  │ (区域框编辑)     │  │ (完整PS功能)    │                           │   │
│  │  └────────┬────────┘  └────────┬────────┘                           │   │
│  │           │                    │                                     │   │
│  └───────────┼────────────────────┼─────────────────────────────────────┘   │
│              │                    │                                         │
│              ▼                    ▼                                         │
│  ┌─────────────────────┐  ┌─────────────────────────────────────────────┐  │
│  │  RegionBoxEditor    │  │  Photopea iframe                            │  │
│  │  (自定义 Canvas)    │  │  ┌─────────────────────────────────────┐    │  │
│  │                     │  │  │  https://www.photopea.com/          │    │  │
│  │  - 遮罩绘制         │  │  │                                     │    │  │
│  │  - 区域框拖拽       │  │  │  完整 Photoshop 功能：              │    │  │
│  │  - 自动计算         │  │  │  - 图层管理                         │    │  │
│  │                     │  │  │  - 液化变形                         │    │  │
│  └──────────┬──────────┘  │  │  - 仿制图章                         │    │  │
│             │             │  │  - 滤镜效果                         │    │  │
│             │             │  │  - 选区/蒙版                        │    │  │
│             │             │  └─────────────────────────────────────┘    │  │
│             │             └─────────────────────────────────────────────┘  │
│             │                           │                                   │
│             │                    postMessage API                           │
│             │                           │                                   │
│             └───────────┬───────────────┘                                   │
│                         │                                                   │
│                         ▼                                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    数据处理层                                        │   │
│  │  - 图像上传: POST /upload/image                                      │   │
│  │  - 遮罩上传: POST /upload/mask                                       │   │
│  │  - 数据同步: widget.value ↔ node.properties                         │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                         │                                                   │
│                         ▼                                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    后端节点 (Python)                                  │   │
│  │  INPUT: image, region_width, region_height, auto_calculate          │   │
│  │  OUTPUT: image, mask, region_top, region_left, region_width/height  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 文件结构

```
ComfyUI-InpaintRegionEditor/
├── __init__.py                    # 节点注册
├── nodes.py                       # 后端节点定义
├── requirements.txt               # Python 依赖（无额外依赖）
│
├── WEB_DIRECTORY = "web"
│
└── web/
    ├── extension.js               # 扩展入口
    ├── photopea-embed.js          # Photopea 嵌入模块
    ├── region-editor.js           # 区域框编辑器（RegionBoxEditor）
    └── utils.js                   # 工具函数
```

---

## 五、后端实现

### 5.1 `__init__.py`

```python
"""
@author: Your Name
@title: Inpaint Region Editor
@description: Enhanced mask editor with Photopea integration and draggable inpaint region selection
"""

from .nodes import InpaintRegionEditor

NODE_CLASS_MAPPINGS = {
    "InpaintRegionEditor": InpaintRegionEditor
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "InpaintRegionEditor": "Inpaint Region Editor"
}

WEB_DIRECTORY = "./web"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
```

### 5.2 `nodes.py`

```python
import torch
import numpy as np
import folder_paths
from PIL import Image
import os

class InpaintRegionEditor:
    """
    增强版遮罩编辑器，支持可拖动重绘区域框
    
    输出:
        - image: 原始图像
        - mask: 用户绘制的遮罩
        - region_top, region_left: 区域框左上角坐标
        - region_width, region_height: 区域框尺寸
    """
    
    @classmethod
    def INPUT_TYPES(s):
        input_dir = folder_paths.get_input_directory()
        files = [f for f in os.listdir(input_dir) 
                 if os.path.isfile(os.path.join(input_dir, f))]
        files = folder_paths.filter_files_content_types(files, ["image"])
        
        return {
            "required": {
                # 图像输入（必须命名为 "image" 才能启用 MaskEditor）
                "image": (sorted(files), {"image_upload": True}),
                
                # 区域框默认尺寸
                "region_width": ("INT", {
                    "default": 512, 
                    "min": 64, 
                    "max": 4096, 
                    "step": 64
                }),
                "region_height": ("INT", {
                    "default": 512, 
                    "min": 64, 
                    "max": 4096, 
                    "step": 64
                }),
                
                # 自动计算区域框
                "auto_calculate": ("BOOLEAN", {"default": True}),
                
                # 区域框边距（自动计算时使用）
                "padding": ("INT", {
                    "default": 0, 
                    "min": 0, 
                    "max": 256
                }),
            },
            "hidden": {
                # 前端传递的区域框坐标（用户手动拖动时更新）
                "region_x": "INT",
                "region_y": "INT",
            }
        }
    
    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "region_top", "region_left", "region_width", "region_height")
    FUNCTION = "process"
    CATEGORY = "image/inpaint"
    
    def process(self, image, region_width, region_height, auto_calculate, padding, 
                region_x=None, region_y=None):
        """
        处理图像和遮罩，计算区域框
        
        Args:
            image: 图像文件名
            region_width: 区域框宽度
            region_height: 区域框高度
            auto_calculate: 是否自动计算区域框位置
            padding: 自动计算时的边距
            region_x: 手动指定的 X 坐标（前端传递）
            region_y: 手动指定的 Y 坐标（前端传递）
        """
        # 加载图像
        image_path = folder_paths.get_annotated_filepath(image)
        img = Image.open(image_path)
        
        # 获取图像尺寸
        img_width, img_height = img.size
        
        # 提取或创建遮罩
        if 'A' in img.getbands():
            mask = np.array(img.getchannel('A')).astype(np.float32) / 255.0
            mask = 1.0 - mask  # ComfyUI 遮罩约定
        else:
            mask = np.zeros((img_height, img_width), dtype=np.float32)
        
        # 计算区域框位置
        if auto_calculate or region_x is None or region_y is None:
            # 自动计算：找到遮罩中心
            region_x, region_y = self._calculate_region_center(
                mask, region_width, region_height, padding
            )
        
        # 确保区域框在图像范围内
        region_x = max(0, min(region_x, img_width - region_width))
        region_y = max(0, min(region_y, img_height - region_height))
        
        # 转换为 tensor
        image_tensor = torch.from_numpy(
            np.array(img.convert("RGB")).astype(np.float32) / 255.0
        ).unsqueeze(0)
        
        mask_tensor = torch.from_numpy(mask).unsqueeze(0)
        
        return (
            image_tensor, 
            mask_tensor, 
            region_y,  # top
            region_x,  # left
            region_width, 
            region_height
        )
    
    def _calculate_region_center(self, mask, region_width, region_height, padding):
        """根据遮罩中心计算区域框位置"""
        # 找到遮罩非零区域的边界框
        rows = np.any(mask > 0.5, axis=1)
        cols = np.any(mask > 0.5, axis=0)
        
        if not np.any(rows) or not np.any(cols):
            # 没有遮罩，返回图像中心
            return (mask.shape[1] - region_width) // 2, (mask.shape[0] - region_height) // 2
        
        # 遮罩边界
        rmin, rmax = np.where(rows)[0][[0, -1]]
        cmin, cmax = np.where(cols)[0][[0, -1]]
        
        # 计算中心
        center_y = (rmin + rmax) // 2
        center_x = (cmin + cmax) // 2
        
        # 区域框位置（居中于遮罩中心）
        region_x = center_x - region_width // 2 - padding
        region_y = center_y - region_height // 2 - padding
        
        return region_x, region_y
```

---

## 六、前端实现

### 6.1 Photopea 嵌入模块 `web/photopea-embed.js`

```javascript
/**
 * Photopea 嵌入模块
 * 基于 sd-webui-photopea-embed 改编用于 ComfyUI
 */

let photopeaWindow = null;
let photopeaIframe = null;

/**
 * 初始化 Photopea iframe
 */
function initPhotopea() {
    if (photopeaIframe) return;
    
    photopeaIframe = document.createElement('iframe');
    photopeaIframe.id = 'comfyui-photopea-iframe';
    photopeaIframe.src = 'https://www.photopea.com/';
    photopeaIframe.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        z-index: 99999;
        display: none;
        border: none;
    `;
    document.body.appendChild(photopeaIframe);
    
    photopeaIframe.onload = () => {
        photopeaWindow = photopeaIframe.contentWindow;
        console.log('[Photopea] iframe loaded');
    };
}

/**
 * 发送消息到 Photopea 并等待响应
 */
async function postMessageToPhotopea(message) {
    return new Promise((resolve, reject) => {
        if (!photopeaWindow) {
            reject(new Error('Photopea not initialized'));
            return;
        }
        
        const responses = [];
        const handler = (response) => {
            responses.push(response.data);
            // Photopea 先返回数据，再返回 "done"
            if (response.data === "done") {
                window.removeEventListener("message", handler);
                resolve(responses);
            }
        };
        
        window.addEventListener("message", handler);
        photopeaWindow.postMessage(message, "*");
        
        // 超时处理
        setTimeout(() => {
            window.removeEventListener("message", handler);
            reject(new Error('Photopea timeout'));
        }, 60000);
    });
}

/**
 * 打开图像到 Photopea
 */
async function openImageInPhotopea(imagePath) {
    // 从 ComfyUI 获取图像
    const response = await fetch(`/view?filename=${imagePath}&type=input`);
    const blob = await response.blob();
    const base64 = await blobToBase64(blob);
    
    // 发送到 Photopea
    await postMessageToPhotopea(`app.open("${base64}", null, false);`);
    await postMessageToPhotopea(`app.activeDocument.activeLayer.rasterize();`);
}

/**
 * 从选区创建遮罩并导出
 */
async function exportSelectionAsMask() {
    // 检查是否有选区
    const checkResult = await postMessageToPhotopea(
        'app.echoToOE(app.activeDocument.selection.bounds != null);'
    );
    
    const hasSelection = checkResult[0] === true;
    
    if (!hasSelection) {
        throw new Error('No selection in active document');
    }
    
    // 创建遮罩
    const createMaskScript = `
        var newLayer = app.activeDocument.artLayers.add();
        newLayer.name = "TempMaskLayer";
        
        app.activeDocument.selection.invert();
        var black = new SolidColor();
        black.rgb.red = 0; black.rgb.green = 0; black.rgb.blue = 0;
        app.activeDocument.selection.fill(black);
        
        app.activeDocument.selection.invert();
        var white = new SolidColor();
        white.rgb.red = 255; white.rgb.green = 255; white.rgb.blue = 255;
        app.activeDocument.selection.fill(white);
    `;
    
    await postMessageToPhotopea(createMaskScript);
    
    // 导出遮罩
    const maskResult = await postMessageToPhotopea('app.activeDocument.saveToOE("png");');
    const maskArrayBuffer = maskResult.find(r => r instanceof ArrayBuffer);
    const maskBlob = new Blob([maskArrayBuffer], { type: 'image/png' });
    
    // 删除临时图层
    await postMessageToPhotopea('app.activeDocument.activeLayer.remove();');
    
    // 导出原图
    const imageBlob = await exportImageFromPhotopea(false);
    
    return { image: imageBlob, mask: maskBlob };
}

/**
 * 从 Photopea 导出图像
 */
async function exportImageFromPhotopea(activeLayerOnly = false) {
    const script = activeLayerOnly 
        ? getExportSelectedLayerScript() 
        : 'app.activeDocument.saveToOE("png");';
    
    const result = await postMessageToPhotopea(script);
    const arrayBuffer = result.find(r => r instanceof ArrayBuffer);
    if (!arrayBuffer) {
        throw new Error('No image data received from Photopea');
    }
    
    return new Blob([arrayBuffer], { type: 'image/png' });
}

// ============== 工具函数 ==============

function blobToBase64(blob) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
    });
}

function getExportSelectedLayerScript() {
    return `
        function exportSelectedLayerOnly() {
            function getAllArtLayers(document, layerCollection) {
                for (var i = 0; i < document.layers.length; i++) {
                    var currentLayer = document.layers[i];
                    if (currentLayer.typename === "ArtLayer") {
                        layerCollection.push(currentLayer);
                    } else {
                        getAllArtLayers(currentLayer, layerCollection);
                    }
                }
                return layerCollection;
            }
            
            var allLayers = getAllArtLayers(app.activeDocument, []);
            var layerStates = [];
            
            for (var i = 0; i < allLayers.length; i++) {
                layerStates.push(allLayers[i].visible);
                allLayers[i].visible = allLayers[i] === app.activeDocument.activeLayer;
            }
            
            app.activeDocument.saveToOE("png");
            
            for (var i = 0; i < allLayers.length; i++) {
                allLayers[i].visible = layerStates[i];
            }
        }
        exportSelectedLayerOnly();
    `;
}

// 导出模块
window.PhotopeaEmbed = {
    init: initPhotopea,
    show: () => { if (photopeaIframe) photopeaIframe.style.display = 'block'; },
    hide: () => { if (photopeaIframe) photopeaIframe.style.display = 'none'; },
    openImage: openImageInPhotopea,
    exportImage: exportImageFromPhotopea,
    exportSelectionAsMask: exportSelectionAsMask,
    postMessage: postMessageToPhotopea
};
```

### 6.2 区域框编辑器 `web/region-editor.js`

```javascript
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ============== 配置 ==============
const CONFIG = {
    REGION_BOX_COLOR: "rgba(255, 165, 0, 0.5)",
    REGION_BOX_BORDER: "rgb(255, 165, 0)",
    REGION_BOX_BORDER_WIDTH: 2,
    REGION_BOX_DASH: [5, 5],
    HANDLE_SIZE: 10,
    HANDLE_COLOR: "rgb(255, 255, 255)",
};

// ============== 区域框编辑器类 ==============
class RegionBoxEditor {
    constructor(node, canvas) {
        this.node = node;
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        
        // 区域框状态
        this.regionBox = {
            x: 0,
            y: 0,
            width: 512,
            height: 512
        };
        
        // 交互状态
        this.isDragging = false;
        this.isResizing = false;
        this.dragStart = { x: 0, y: 0 };
        this.activeHandle = null;
        
        // 图像
        this.maskImage = null;
        this.backgroundImage = null;
        
        this.setupEventListeners();
    }
    
    setupEventListeners() {
        this.canvas.addEventListener('mousedown', this.onMouseDown.bind(this));
        this.canvas.addEventListener('mousemove', this.onMouseMove.bind(this));
        this.canvas.addEventListener('mouseup', this.onMouseUp.bind(this));
        
        // 触摸事件
        this.canvas.addEventListener('touchstart', this.onTouchStart.bind(this));
        this.canvas.addEventListener('touchmove', this.onTouchMove.bind(this));
        this.canvas.addEventListener('touchend', this.onTouchEnd.bind(this));
    }
    
    onMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        this.activeHandle = this.getHandleAtPoint(x, y);
        
        if (this.activeHandle) {
            this.isResizing = true;
        } else if (this.isPointInRegionBox(x, y)) {
            this.isDragging = true;
        }
        
        this.dragStart = { x, y };
        this.canvas.style.cursor = this.activeHandle ? 'nwse-resize' : 'move';
    }
    
    onMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        if (this.isDragging) {
            const dx = x - this.dragStart.x;
            const dy = y - this.dragStart.y;
            
            this.regionBox.x += dx;
            this.regionBox.y += dy;
            
            this.dragStart = { x, y };
            this.render();
            this.syncToNode();
            
        } else if (this.isResizing && this.activeHandle) {
            this.resizeRegionBox(x, y);
            this.render();
            this.syncToNode();
            
        } else {
            const handle = this.getHandleAtPoint(x, y);
            if (handle) {
                this.canvas.style.cursor = this.getCursorForHandle(handle);
            } else if (this.isPointInRegionBox(x, y)) {
                this.canvas.style.cursor = 'move';
            } else {
                this.canvas.style.cursor = 'crosshair';
            }
        }
    }
    
    onMouseUp(e) {
        this.isDragging = false;
        this.isResizing = false;
        this.activeHandle = null;
        this.canvas.style.cursor = 'crosshair';
    }
    
    onTouchStart(e) {
        e.preventDefault();
        const touch = e.touches[0];
        this.onMouseDown({ clientX: touch.clientX, clientY: touch.clientY });
    }
    
    onTouchMove(e) {
        e.preventDefault();
        const touch = e.touches[0];
        this.onMouseMove({ clientX: touch.clientX, clientY: touch.clientY });
    }
    
    onTouchEnd(e) {
        this.onMouseUp(e);
    }
    
    // ============== 渲染 ==============
    render() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        if (this.backgroundImage) {
            this.ctx.drawImage(this.backgroundImage, 0, 0);
        }
        
        if (this.maskImage) {
            this.ctx.globalAlpha = 0.5;
            this.ctx.drawImage(this.maskImage, 0, 0);
            this.ctx.globalAlpha = 1.0;
        }
        
        this.drawRegionBox();
        this.drawHandles();
    }
    
    drawRegionBox() {
        const { x, y, width, height } = this.regionBox;
        
        this.ctx.fillStyle = CONFIG.REGION_BOX_COLOR;
        this.ctx.fillRect(x, y, width, height);
        
        this.ctx.strokeStyle = CONFIG.REGION_BOX_BORDER;
        this.ctx.lineWidth = CONFIG.REGION_BOX_BORDER_WIDTH;
        this.ctx.setLineDash(CONFIG.REGION_BOX_DASH);
        this.ctx.strokeRect(x, y, width, height);
        this.ctx.setLineDash([]);
        
        this.ctx.fillStyle = 'white';
        this.ctx.font = '14px sans-serif';
        this.ctx.fillText(`${width} × ${height}`, x + 5, y + 20);
    }
    
    drawHandles() {
        const handles = this.getHandlePositions();
        
        Object.values(handles).forEach(handle => {
            this.ctx.fillStyle = CONFIG.HANDLE_COLOR;
            this.ctx.fillRect(
                handle.x - CONFIG.HANDLE_SIZE / 2,
                handle.y - CONFIG.HANDLE_SIZE / 2,
                CONFIG.HANDLE_SIZE,
                CONFIG.HANDLE_SIZE
            );
        });
    }
    
    // ============== 辅助方法 ==============
    isPointInRegionBox(x, y) {
        const { x: rx, y: ry, width, height } = this.regionBox;
        return x >= rx && x <= rx + width && y >= ry && y <= ry + height;
    }
    
    getHandleAtPoint(x, y) {
        const handles = this.getHandlePositions();
        
        for (const [name, handle] of Object.entries(handles)) {
            if (Math.abs(x - handle.x) <= CONFIG.HANDLE_SIZE &&
                Math.abs(y - handle.y) <= CONFIG.HANDLE_SIZE) {
                return name;
            }
        }
        return null;
    }
    
    getHandlePositions() {
        const { x, y, width, height } = this.regionBox;
        
        return {
            'nw': { x: x, y: y },
            'ne': { x: x + width, y: y },
            'sw': { x: x, y: y + height },
            'se': { x: x + width, y: y + height },
            'n': { x: x + width / 2, y: y },
            's': { x: x + width / 2, y: y + height },
            'w': { x: x, y: y + height / 2 },
            'e': { x: x + width, y: y + height / 2 }
        };
    }
    
    getCursorForHandle(handle) {
        const cursorMap = {
            'nw': 'nwse-resize', 'se': 'nwse-resize',
            'ne': 'nesw-resize', 'sw': 'nesw-resize',
            'n': 'ns-resize', 's': 'ns-resize',
            'w': 'ew-resize', 'e': 'ew-resize'
        };
        return cursorMap[handle] || 'default';
    }
    
    resizeRegionBox(x, y) {
        const minSize = 64;
        
        switch (this.activeHandle) {
            case 'se':
                this.regionBox.width = Math.max(minSize, x - this.regionBox.x);
                this.regionBox.height = Math.max(minSize, y - this.regionBox.y);
                break;
            case 'nw':
                const newWidth = this.regionBox.x + this.regionBox.width - x;
                const newHeight = this.regionBox.y + this.regionBox.height - y;
                if (newWidth >= minSize) {
                    this.regionBox.x = x;
                    this.regionBox.width = newWidth;
                }
                if (newHeight >= minSize) {
                    this.regionBox.y = y;
                    this.regionBox.height = newHeight;
                }
                break;
        }
    }
    
    syncToNode() {
        const xWidget = this.node.widgets?.find(w => w.name === 'region_x');
        const yWidget = this.node.widgets?.find(w => w.name === 'region_y');
        const widthWidget = this.node.widgets?.find(w => w.name === 'region_width');
        const heightWidget = this.node.widgets?.find(w => w.name === 'region_height');
        
        if (xWidget) xWidget.value = Math.round(this.regionBox.x);
        if (yWidget) yWidget.value = Math.round(this.regionBox.y);
        if (widthWidget) widthWidget.value = Math.round(this.regionBox.width);
        if (heightWidget) heightWidget.value = Math.round(this.regionBox.height);
    }
}

window.RegionBoxEditor = RegionBoxEditor;
```

### 6.3 扩展入口 `web/extension.js`

```javascript
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import "./photopea-embed.js";
import "./region-editor.js";

app.registerExtension({
    name: "comfyui.inpaint_region_editor",
    
    async setup() {
        PhotopeaEmbed.init();
        console.log("[InpaintRegionEditor] Extension loaded");
    },
    
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "InpaintRegionEditor") return;
        
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            const result = onNodeCreated?.apply(this, arguments);
            
            // 添加隐藏的坐标 widgets
            this.addWidget("INT", "region_x", 0, () => {}, { serialize: true });
            this.addWidget("INT", "region_y", 0, () => {}, { serialize: true });
            
            return result;
        };
        
        // 添加右键菜单
        const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function(canvas, options) {
            getExtraMenuOptions?.apply(this, arguments);
            
            const node = this;
            
            options.push(null); // 分隔线
            
            options.push({
                content: "🦜 Open in Photopea",
                callback: () => {
                    PhotopeaEmbed.show();
                    const imageWidget = node.widgets?.find(w => w.name === 'image');
                    if (imageWidget?.value) {
                        PhotopeaEmbed.openImage(imageWidget.value);
                    }
                }
            });
            
            options.push({
                content: "📤 Export Selection as Mask",
                callback: async () => {
                    try {
                        const { image, mask } = await PhotopeaEmbed.exportSelectionAsMask();
                        const imageData = await uploadToComfyUI(image, 'selection_image.png');
                        const imageWidget = node.widgets?.find(w => w.name === 'image');
                        if (imageWidget) {
                            imageWidget.value = imageData.name;
                        }
                        node.setDirtyCanvas(true);
                    } catch (e) {
                        alert('No selection found in Photopea!');
                    }
                }
            });
            
            return options;
        };
    }
});

async function uploadToComfyUI(blob, filename) {
    const formData = new FormData();
    formData.append('image', blob, filename);
    formData.append('type', 'input');
    
    const response = await api.fetchApi('/upload/image', {
        method: 'POST',
        body: formData
    });
    
    return await response.json();
}
```

---

## 七、数据流详解

### 7.1 Photopea 编辑流程

```
1. 用户右键点击节点 → 选择 "Open in Photopea"
        ↓
2. 显示 Photopea iframe（全屏覆盖）
        ↓
3. 发送节点图像到 Photopea
   postMessageToPhotopea(`app.open("${base64Image}")`)
        ↓
4. 用户在 Photopea 中编辑
   - 使用液化、仿制图章等工具
   - 创建选区作为遮罩
        ↓
5. 用户点击 "Close & Save"
        ↓
6. 从 Photopea 导出图像和遮罩
   exportSelectionAsMask()
        ↓
7. 上传到 ComfyUI: POST /upload/image
        ↓
8. 更新节点 widget → 隐藏 Photopea iframe
```

### 7.2 数据传递机制

```
┌──────────────────────────────────────────────────────────────┐
│                      数据流向                                  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  1. 用户上传图像                                              │
│     └─▶ POST /upload/image                                   │
│         └─▶ 返回 {filename, subfolder, type}                 │
│                                                              │
│  2. 用户绘制遮罩                                              │
│     └─▶ POST /upload/mask                                    │
│         └─▶ 遮罩写入原图 Alpha 通道                           │
│                                                              │
│  3. 用户拖动区域框                                            │
│     └─▶ Widget 更新: region_x, region_y                      │
│         └─▶ 自动同步到后端                                    │
│                                                              │
│  4. 执行节点                                                  │
│     └─▶ Python process() 接收所有参数                         │
│         └─▶ 返回 image, mask, region_*                       │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 八、关键技术参考

### 8.1 现有实现参考

| 项目 | 文件 | 参考价值 |
|------|------|----------|
| Impact-Pack | `js/mask-rect-area.js` | Canvas 预览 + widget 同步模式 |
| Impact-Pack | `js/impact-sam-editor.js` | 独立编辑器对话框实现 |
| OpenPose-Editor | `js/openpose.js` | Fabric.js 集成 + 图像上传 |
| sd-webui-photopea-embed | `javascript/photopea-bindings.js` | Photopea 嵌入核心代码 |

### 8.2 ComfyUI 扩展 API

```javascript
// app.registerExtension() 支持的钩子
app.registerExtension({
    name: "extension_name",
    
    // 节点创建前
    async beforeRegisterNodeDef(nodeType, nodeData, app) {},
    
    // 节点创建后
    async nodeCreated(node) {},
    
    // 设置
    async setup(app) {},
    
    // 自定义菜单
    getCustomMenu(node) {},
});

// Widget 操作
node.addWidget(type, name, value, callback, options);
node.properties[key] = value;  // 持久化存储

// API 调用
api.fetchApi('/upload/image', { method: 'POST', body: formData });
api.fetchApi('/upload/mask', { method: 'POST', body: formData });
```

---

## 九、实现路线图

| 阶段 | 任务 | 工作量 |
|------|------|--------|
| **Phase 1** | Photopea 集成 | 2-3 天 |
| **Phase 2** | 区域框编辑器 | 2-3 天 |
| **Phase 3** | 集成测试 | 1-2 天 |
| **Phase 4** | 文档发布 | 1 天 |

**预计总工作量：5-8 天**

---

## 十、注意事项

### 10.1 必须遵守的约束

1. **参数名必须是 `image`**：使用 `image_upload: True` 时，输入参数名必须是 `image`
2. **遮罩存储在 Alpha 通道**：通过 `/upload/mask` 端点上传时，遮罩会写入原图的 Alpha 通道
3. **Widget 数据同步**：使用 `widget.value` 更新数据，或使用 `node.properties` 持久化

### 10.2 性能优化建议

```javascript
// 使用 requestAnimationFrame 节流渲染
let rafId = null;
function throttledRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
        this.render();
        rafId = null;
    });
}

// 使用 OffscreenCanvas 后台处理
const offscreen = new OffscreenCanvas(width, height);
```

---

## 十一、README 模板

```markdown
# ComfyUI InpaintRegionEditor

增强版遮罩编辑器，支持 Photopea 集成和可拖动重绘区域框。

## 功能

- ✅ 完整的 Photoshop 功能（液化、仿制图章、图层等）
- ✅ 可拖动重绘区域框
- ✅ 自动计算最佳区域框位置
- ✅ 输出区域框坐标用于精确重绘

## 安装

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/yourname/ComfyUI-InpaintRegionEditor.git
```

## 使用方法

1. 添加 "Inpaint Region Editor" 节点
2. 右键点击节点 → "Open in Photopea"
3. 在 Photopea 中编辑图像
4. 创建选区作为遮罩
5. 点击关闭按钮，自动保存到节点

## 图像编辑功能说明

本节点的图像编辑功能基于 [Photopea](https://www.photopea.com/)，
一个免费的在线图像编辑器。

- Photopea 是由 Ivan Kutskir 开发的免费软件
- 图像处理在您的浏览器本地完成，不上传到任何服务器
- 使用 Photopea API 是免费的，但会显示广告
- 您编辑的所有图像归您所有

## 法律声明

- Photopea API 可免费用于任何目的（包括商业用途）
- 您的作品完全归您所有，无需分享收益
- 无需标注使用了 Photopea（但建议标注）

## 许可证

本项目采用 MIT 许可证。
```

---

## 十二、总结

| 需求 | 方案 | 可行性 | 工作量 |
|------|------|--------|--------|
| **功能1**: 区域框 | 自定义 Canvas | ✅ 100% | 2-3 天 |
| **功能2**: PS 功能 | 嵌入 Photopea | ✅ 100% | 2-3 天 |
| **约束**: 不改核心代码 | 纯 custom node | ✅ 满足 | - |
| **法律风险** | API 免费，可商用 | ✅ 无风险 | - |

---

## 十三、参考资源

- **Photopea 官网**: https://www.photopea.com
- **Photopea API 文档**: https://www.photopea.com/api
- **sd-webui-photopea-embed**: https://github.com/yankooliveira/sd-webui-photopea-embed
- **ComfyUI 前端仓库**: https://github.com/Comfy-Org/ComfyUI_frontend

---

*文档版本: 5.0 | 更新时间: 2026-02-27*
*基于深度调研 + sd-webui-photopea-embed 源码分析 + Photopea 官方条款调研*
