# InpaintRegionEditor 最终实现方案

> 版本：1.0 | 日期：2026-03-02
> 基于用户需求最终确认

---

## 一、核心需求

### 1.1 功能定位

**InpaintRegionEditor = LoadImage + 蒙版编辑 + 选区调整**

- 替代系统 LoadImage 节点
- 支持图像上传
- 支持蒙版编辑（Photopea 集成）
- 支持选区调整（拖动 + 扩散像素）
- 输出：IMAGE, MASK, region_*

### 1.2 蒙版来源（三种）

1. **用户上传**：带 Alpha 通道的 PNG
2. **Photopea 编辑**：在 Photopea 里画蒙版后保存
3. **系统工具**：ComfyUI 自带蒙版工具绘制后保存

### 1.3 核心逻辑

```
if 没有蒙版:
    执行时报错："请先创建蒙版（局部重绘需要蒙版）"
else:
    自动计算选区 = 蒙版边界 + padding
    在预览上绘制遮罩 + 选区框
    用户可以拖动选区
    输出 region_* 坐标
```

---

## 二、文件结构

```
ComfyUI-InpaintRegionEditor/
├── __init__.py                 # 节点注册
├── nodes.py                    # 后端节点逻辑
├── requirements.txt            # 无额外依赖
│
├── web/
│   ├── extension.js            # 扩展入口 + 右键菜单
│   ├── photopea-bridge.js      # Photopea 通信桥接
│   ├── photopea-modal.js       # Photopea 全屏对话框
│   ├── region-box-editor.js    # 选区框编辑器（Canvas + 拖动）
│   └── style.css               # 样式（可选）
│
└── docs/
    ├── technical-validation.md # 技术验证清单
    └── implementation-plan.md  # 本方案
```

---

## 三、后端实现（nodes.py）

### 3.1 节点定义

```python
import torch
import numpy as np
import folder_paths
from PIL import Image
import os
import json


class InpaintRegionEditor:
    """
    增强版遮罩编辑器，支持 Photopea 集成和可拖动选区
    
    概念说明：
    - 遮罩 (Mask): 定义重绘区域，AI 在这个区域内生成新内容
    - 选区 (Region): 定义参考区域，AI 参考这个区域内的原图内容
    
    约束：选区必须 >= 遮罩
    """
    
    @classmethod
    def INPUT_TYPES(s):
        input_dir = folder_paths.get_input_directory()
        files = [f for f in os.listdir(input_dir) 
                 if os.path.isfile(os.path.join(input_dir, f))]
        files = folder_paths.filter_files_content_types(files, ["image"])
        
        return {
            "required": {
                # 图像输入
                "image": (sorted(files), {"image_upload": True}),
                
                # 扩散像素数（选区 = 遮罩边界 + padding）
                "padding": ("INT", {
                    "default": 64, 
                    "min": 0, 
                    "max": 512, 
                    "step": 32
                }),
            },
            "hidden": {
                # 前端传递的选区坐标（用户拖动后更新）
                "region_coords": "STRING",
            }
        }
    
    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "region_top", "region_left", "region_width", "region_height")
    FUNCTION = "process"
    CATEGORY = "image/inpaint"
    
    def process(self, image, padding, region_coords=None):
        """
        处理图像和遮罩，计算选区位置
        
        Args:
            image: 图像文件名
            padding: 扩散像素数
            region_coords: 前端传递的选区坐标 JSON（用户拖动后）
        """
        # 加载图像
        image_path = folder_paths.get_annotated_filepath(image)
        img = Image.open(image_path)
        
        img_width, img_height = img.size
        
        # 提取 MASK（从 Alpha 通道）
        if 'A' in img.getbands():
            mask = np.array(img.getchannel('A')).astype(np.float32) / 255.0
            mask = 1.0 - mask  # ComfyUI 约定：1=遮罩区域，0=背景
        else:
            # 没有蒙版 → 报错
            raise ValueError(
                "请先创建蒙版（局部重绘需要蒙版）\n"
                "可以通过以下方式创建：\n"
                "1. 上传带 Alpha 通道的 PNG\n"
                "2. 使用 Photopea 编辑后保存蒙版\n"
                "3. 使用 ComfyUI 系统蒙版工具绘制"
            )
        
        # 计算蒙版边界框
        mask_bounds = self._calculate_mask_bounds(mask)
        
        # 解析前端传递的选区坐标（用户拖动后）
        region_rect = None
        if region_coords:
            try:
                region_rect = json.loads(region_coords)
            except:
                pass
        
        # 如果没有前端坐标，自动计算
        if not region_rect:
            region_rect = self._calculate_region_rect(mask_bounds, padding)
        
        # 验证：选区必须 >= 遮罩
        if (region_rect['width'] < mask_bounds['width'] or 
            region_rect['height'] < mask_bounds['height']):
            raise ValueError(
                f"选区太小！必须 >= 遮罩\n"
                f"选区：{region_rect['width']}×{region_rect['height']}\n"
                f"遮罩：{mask_bounds['width']}×{mask_bounds['height']}"
            )
        
        # 确保选区在图像范围内
        region_rect = self._clamp_to_image(region_rect, img_width, img_height)
        
        # 转换为 tensor
        image_tensor = torch.from_numpy(
            np.array(img.convert("RGB")).astype(np.float32) / 255.0
        ).unsqueeze(0)
        
        mask_tensor = torch.from_numpy(mask).unsqueeze(0)
        
        return (
            image_tensor, 
            mask_tensor, 
            int(region_rect['y']),      # top
            int(region_rect['x']),      # left
            int(region_rect['width']),  # width
            int(region_rect['height'])  # height
        )
    
    def _calculate_mask_bounds(self, mask):
        """计算遮罩的边界框"""
        rows = np.any(mask > 0.5, axis=1)
        cols = np.any(mask > 0.5, axis=0)
        
        if not np.any(rows) or not np.any(cols):
            # 没有遮罩
            return {'x': 0, 'y': 0, 'width': 0, 'height': 0}
        
        rmin, rmax = np.where(rows)[0][[0, -1]]
        cmin, cmax = np.where(cols)[0][[0, -1]]
        
        return {
            'x': int(cmin),
            'y': int(rmin),
            'width': int(cmax - cmin + 1),
            'height': int(rmax - rmin + 1)
        }
    
    def _calculate_region_rect(self, mask_bounds, padding):
        """根据遮罩边界 + padding 计算选区"""
        return {
            'x': mask_bounds['x'] - padding,
            'y': mask_bounds['y'] - padding,
            'width': mask_bounds['width'] + padding * 2,
            'height': mask_bounds['height'] + padding * 2
        }
    
    def _clamp_to_image(self, rect, img_width, img_height):
        """确保矩形在图像范围内"""
        x = max(0, min(rect['x'], img_width - rect['width']))
        y = max(0, min(rect['y'], img_height - rect['height']))
        
        return {
            'x': x,
            'y': y,
            'width': rect['width'],
            'height': rect['height']
        }
```

---

## 四、前端实现

### 4.1 extension.js（扩展入口）

```javascript
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { PhotopeaModal } from "./photopea-modal.js";
import { RegionBoxEditor } from "./region-box-editor.js";

app.registerExtension({
    name: "InpaintRegionEditor",
    
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "InpaintRegionEditor") return;
        
        // 添加 Photopea 右键菜单
        const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function(canvas, options) {
            getExtraMenuOptions?.apply(this, arguments);
            
            const node = this;
            const imageWidget = node.widgets?.find(w => w.name === "image");
            
            options.push(null); // 分隔线
            
            options.push({
                content: "🎨 打开 Photopea 编辑",
                callback: () => {
                    if (imageWidget?.value) {
                        PhotopeaModal.show(node, imageWidget.value);
                    } else {
                        alert("请先加载图像");
                    }
                }
            });
            
            return options;
        };
        
        // 添加选区框编辑器
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            const result = onNodeCreated?.apply(this, arguments);
            
            // 隐藏的区域坐标 widget（存储用户拖动后的坐标）
            const coordsWidget = this.addWidget("STRING", "region_coords", "{}", () => {}, { 
                serialize: true,
                hidden: true
            });
            
            // 添加选区框 Canvas
            this.regionEditor = new RegionBoxEditor(this, app.canvas);
            
            return result;
        };
        
        // 节点执行时更新选区
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function(message) {
            onExecuted?.apply(this, arguments);
            
            // 更新选区框（使用后端返回的坐标）
            if (this.regionEditor && message.region_coords) {
                this.regionEditor.updateRegion(message.region_coords);
            }
        };
        
        // 节点绘制时渲染选区框
        const onDrawBackground = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function(ctx, nodeWidget, nodeWidth, nodeHeight) {
            onDrawBackground?.apply(this, arguments);
            
            // 在图像预览上绘制选区框
            if (this.regionEditor) {
                this.regionEditor.draw(ctx, nodeWidth, nodeHeight);
            }
        };
    }
});
```

### 4.2 region-box-editor.js（选区框编辑器）

```javascript
/**
 * 选区框编辑器
 * 在节点图像预览上绘制可拖动的选区框
 */

export class RegionBoxEditor {
    constructor(node, canvas) {
        this.node = node;
        this.canvas = canvas;
        
        // 选区矩形
        this.regionRect = {
            x: 0,
            y: 0,
            width: 200,
            height: 200
        };
        
        // 遮罩边界（自动计算）
        this.maskBounds = {
            x: 0,
            y: 0,
            width: 100,
            height: 100
        };
        
        // 交互状态
        this.isDragging = false;
        this.dragStart = { x: 0, y: 0 };
        
        // 样式配置
        this.config = {
            maskColor: "rgba(255, 0, 0, 0.5)",      // 遮罩：半透明红
            regionColor: "rgba(255, 165, 0, 0.3)",  // 选区：半透明橙
            regionBorder: "rgb(255, 165, 0)",       // 选区边框：橙色
            regionDash: [5, 5],                     // 虚线
            handleSize: 8,                          // 拖动手柄大小
        };
        
        this.setupEventListeners();
    }
    
    setupEventListeners() {
        // 监听鼠标事件（拖动选区）
        const canvasElement = this.canvas.canvas;
        
        canvasElement.addEventListener('mousedown', (e) => this.onMouseDown(e));
        canvasElement.addEventListener('mousemove', (e) => this.onMouseMove(e));
        canvasElement.addEventListener('mouseup', () => this.onMouseUp());
    }
    
    onMouseDown(e) {
        const rect = this.canvas.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        // 检查是否点击在选区框内
        if (this.isPointInRect(x, y, this.regionRect)) {
            this.isDragging = true;
            this.dragStart = { x, y };
            this.canvas.canvas.style.cursor = 'move';
        }
    }
    
    onMouseMove(e) {
        if (!this.isDragging) return;
        
        const rect = this.canvas.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        const dx = x - this.dragStart.x;
        const dy = y - this.dragStart.y;
        
        // 更新选区位置
        this.regionRect.x += dx;
        this.regionRect.y += dy;
        
        this.dragStart = { x, y };
        
        // 同步到节点 widget
        this.syncToNode();
        
        // 重绘
        this.canvas.setDirty(true);
    }
    
    onMouseUp() {
        this.isDragging = false;
        this.canvas.canvas.style.cursor = 'default';
    }
    
    isPointInRect(x, y, rect) {
        return x >= rect.x && x <= rect.x + rect.width &&
               y >= rect.y && y <= rect.y + rect.height;
    }
    
    draw(ctx, nodeWidth, nodeHeight) {
        // 绘制遮罩预览（半透明红）
        if (this.maskBounds.width > 0) {
            ctx.fillStyle = this.config.maskColor;
            ctx.fillRect(
                this.maskBounds.x,
                this.maskBounds.y,
                this.maskBounds.width,
                this.maskBounds.height
            );
        }
        
        // 绘制选区框（橙色虚线）
        ctx.fillStyle = this.config.regionColor;
        ctx.fillRect(
            this.regionRect.x,
            this.regionRect.y,
            this.regionRect.width,
            this.regionRect.height
        );
        
        ctx.strokeStyle = this.config.regionBorder;
        ctx.lineWidth = 2;
        ctx.setLineDash(this.config.regionDash);
        ctx.strokeRect(
            this.regionRect.x,
            this.regionRect.y,
            this.regionRect.width,
            this.regionRect.height
        );
        ctx.setLineDash([]);
        
        // 绘制尺寸标签
        ctx.fillStyle = 'white';
        ctx.font = '12px sans-serif';
        ctx.fillText(
            `${this.regionRect.width}×${this.regionRect.height}`,
            this.regionRect.x + 5,
            this.regionRect.y + 15
        );
    }
    
    updateRegion(regionRect) {
        // 更新选区坐标（从后端返回）
        this.regionRect = regionRect;
        this.canvas.setDirty(true);
    }
    
    updateMaskBounds(maskBounds) {
        // 更新遮罩边界（自动计算选区）
        this.maskBounds = maskBounds;
        
        // 自动计算选区（如果还没手动拖动过）
        if (!this.userDragged) {
            const padding = this.node.widgets?.find(w => w.name === "padding")?.value || 64;
            this.regionRect = {
                x: maskBounds.x - padding,
                y: maskBounds.y - padding,
                width: maskBounds.width + padding * 2,
                height: maskBounds.height + padding * 2
            };
        }
        
        this.canvas.setDirty(true);
    }
    
    syncToNode() {
        // 同步选区坐标到节点 widget
        const coordsWidget = this.node.widgets?.find(w => w.name === "region_coords");
        if (coordsWidget) {
            coordsWidget.value = JSON.stringify(this.regionRect);
        }
        
        this.userDragged = true;
    }
}
```

### 4.3 photopea-modal.js（Photopea 对话框）

```javascript
import { PhotopeaBridge } from "./photopea-bridge.js";

export class PhotopeaModal {
    static instance = null;
    static node = null;
    
    static show(node, imagePath) {
        this.node = node;
        this.createUI();
        this.loadImage(imagePath);
    }
    
    static createUI() {
        // 创建全屏对话框
        this.modal = document.createElement('div');
        this.modal.className = 'photopea-modal';
        this.modal.innerHTML = `
            <div class="photopea-container">
                <iframe id="photopea-iframe" src="https://www.photopea.com/"></iframe>
                <div class="photopea-toolbar">
                    <span class="toolbar-hint">💡 编辑后保存，图像和蒙版会自动同步到节点</span>
                    <div class="toolbar-buttons">
                        <button id="btn-save-image" class="btn btn-primary">💾 保存图像</button>
                        <button id="btn-save-mask" class="btn btn-success">🎭 保存蒙版</button>
                        <button id="btn-cancel" class="btn btn-secondary">❌ 取消</button>
                    </div>
                </div>
                <div class="status-bar" id="status-bar">正在加载 Photopea...</div>
            </div>
        `;
        
        document.body.appendChild(this.modal);
        
        // 初始化 Photopea
        const iframe = document.getElementById('photopea-iframe');
        iframe.onload = () => {
            PhotopeaBridge.init(iframe);
            document.getElementById('status-bar').textContent = 'Photopea 已就绪';
        };
        
        // 绑定按钮事件
        document.getElementById('btn-save-image').onclick = () => this.saveImage();
        document.getElementById('btn-save-mask').onclick = () => this.saveMask();
        document.getElementById('btn-cancel').onclick = () => this.close();
    }
    
    static async loadImage(imagePath) {
        try {
            // 从 ComfyUI 获取图像（加 channel=rgb 获取纯 RGB）
            const response = await fetch(`/view?filename=${imagePath}&type=input&channel=rgb`);
            const blob = await response.blob();
            await PhotopeaBridge.openImage(blob);
            document.getElementById('status-bar').textContent = '图像已加载';
        } catch (e) {
            document.getElementById('status-bar').textContent = '加载失败：' + e.message;
        }
    }
    
    static async saveImage() {
        try {
            document.getElementById('status-bar').textContent = '正在导出图像...';
            
            const blob = await PhotopeaBridge.exportImage();
            const result = await this.uploadToComfyUI(blob, 'edited_image.png');
            
            if (result.name) {
                const imageWidget = this.node.widgets?.find(w => w.name === "image");
                if (imageWidget) {
                    imageWidget.value = result.name;
                }
                document.getElementById('status-bar').textContent = '✅ 图像已保存';
                setTimeout(() => this.close(), 500);
            }
        } catch (e) {
            document.getElementById('status-bar').textContent = '导出失败：' + e.message;
        }
    }
    
    static async saveMask() {
        try {
            document.getElementById('status-bar').textContent = '正在导出蒙版...';
            
            const blob = await PhotopeaBridge.exportMask();
            const result = await this.uploadToComfyUI(blob, 'mask.png');
            
            // 注意：蒙版需要特殊处理，合成到原图的 Alpha 通道
            // 这里简化处理，实际可能需要后端配合
            if (result.name) {
                document.getElementById('status-bar').textContent = '✅ 蒙版已保存';
                setTimeout(() => this.close(), 500);
            }
        } catch (e) {
            document.getElementById('status-bar').textContent = '导出失败：' + e.message;
        }
    }
    
    static async uploadToComfyUI(blob, filename) {
        const formData = new FormData();
        formData.append('image', blob, filename);
        formData.append('type', 'input');
        
        const response = await api.fetchApi('/upload/image', {
            method: 'POST',
            body: formData
        });
        
        return await response.json();
    }
    
    static close() {
        this.modal?.remove();
        this.modal = null;
        this.node = null;
    }
}
```

### 4.4 photopea-bridge.js（Photopea 通信）

```javascript
/**
 * Photopea 通信桥接
 */
export class PhotopeaBridge {
    static iframe = null;
    static photopeaWindow = null;
    static PHOTOPEA_ORIGIN = "https://www.photopea.com";
    
    static init(iframe) {
        this.iframe = iframe;
        this.photopeaWindow = iframe.contentWindow;
    }
    
    static async postMessage(message) {
        return new Promise((resolve, reject) => {
            if (!this.photopeaWindow) {
                reject(new Error('Photopea not initialized'));
                return;
            }
            
            const responses = [];
            const timeoutId = setTimeout(() => {
                reject(new Error('Photopea timeout'));
            }, 60000);
            
            const handler = (event) => {
                if (event.origin !== this.PHOTOPEA_ORIGIN) return;
                
                responses.push(event.data);
                
                if (event.data === "done") {
                    clearTimeout(timeoutId);
                    window.removeEventListener("message", handler);
                    resolve(responses);
                }
            };
            
            window.addEventListener("message", handler);
            this.photopeaWindow.postMessage(message, "*");
        });
    }
    
    static async openImage(blob) {
        const base64 = await this.blobToBase64(blob);
        await this.postMessage(`app.open("${base64}");`);
    }
    
    static async exportImage() {
        const result = await this.postMessage('app.activeDocument.saveToOE("png");');
        const arrayBuffer = result.find(r => r instanceof ArrayBuffer);
        return new Blob([arrayBuffer], { type: 'image/png' });
    }
    
    static async exportMask() {
        // TODO: 需要测试 Photopea 能否单独导出蒙版
        // 这里使用 workaround 方案
        const script = `
            (function() {
                var doc = app.activeDocument;
                var layer = doc.activeLayer;
                
                // 尝试获取蒙版
                if (layer.mask) {
                    doc.activeChannel = layer.mask;
                    doc.selection.selectAll();
                    doc.selection.copy();
                    
                    var newDoc = app.documents.add(doc.width, doc.height);
                    app.activeDocument = newDoc;
                    newDoc.paste();
                    newDoc.saveToOE("png");
                    newDoc.close(SaveOptions.DONOTSAVECHANGES);
                    
                    app.activeDocument = doc;
                    app.echoToOE("mask_exported");
                } else {
                    app.echoToOE("no_mask");
                }
            })();
        `;
        
        const result = await this.postMessage(script);
        // 处理结果...
    }
    
    static blobToBase64(blob) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
        });
    }
}
```

### 4.5 style.css（样式）

```css
.photopea-modal {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.9);
    z-index: 99999;
    display: flex;
    align-items: center;
    justify-content: center;
}

.photopea-container {
    width: 95%;
    height: 95%;
    display: flex;
    flex-direction: column;
    background: #1e1e1e;
    border-radius: 8px;
    overflow: hidden;
}

#photopea-iframe {
    flex: 1;
    width: 100%;
    border: none;
}

.photopea-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    background: #2d2d2d;
    border-top: 1px solid #444;
}

.toolbar-hint {
    color: #888;
    font-size: 13px;
}

.toolbar-buttons {
    display: flex;
    gap: 10px;
}

.btn {
    padding: 10px 18px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
}

.btn-primary {
    background: #0078d4;
    color: white;
}

.btn-success {
    background: #107c10;
    color: white;
}

.btn-secondary {
    background: #555;
    color: white;
}

.status-bar {
    padding: 8px 16px;
    background: #1a1a1a;
    color: #888;
    font-size: 12px;
}
```

---

## 五、待验证的技术点

### 5.1 Photopea 相关（需要测试）

1. **同时加载原图 + 蒙版**
   - 能否用 `app.open()` 加载两个文件？
   - 能否让蒙版作为图层蒙版（不是普通图层）？

2. **单独导出蒙版**
   - `exportMask()` 能否工作？
   - 如果 layer.mask 返回 null，workaround 是否有效？

3. **检测是否有蒙版**
   - 在保存前能否检测用户是否画了蒙版？

### 5.2 前端 Canvas 相关

1. **在节点上绘制**
   - 参考 Impact-Pack 的 `mask-rect-area.js`
   - 需要处理 Canvas 坐标转换

2. **拖动交互**
   - 鼠标事件监听
   - 约束：选区不能小于遮罩

### 5.3 后端相关

1. **蒙版检测**
   - 没有 Alpha 通道时报错

2. **选区坐标传递**
   - 前端 → 后端：通过 hidden widget
   - 后端 → 前端：通过消息返回

---

## 六、实现路线图

### Phase 1：后端基础（1 天）
- [ ] 完成 `nodes.py` 基础逻辑
- [ ] 测试蒙版提取
- [ ] 测试选区计算

### Phase 2：前端选区 UI（2 天）
- [ ] 完成 `region-box-editor.js`
- [ ] 在节点上绘制遮罩 + 选区框
- [ ] 实现拖动功能

### Phase 3：Photopea 集成（2-3 天）
- [ ] 完成 `photopea-modal.js`
- [ ] 测试图像加载
- [ ] 测试图像导出
- [ ] 测试蒙版导出（待验证）

### Phase 4：集成测试（1 天）
- [ ] 完整工作流测试
- [ ] 修复 bug

---

## 七、已知风险

1. **Photopea API 限制**：
   - `layer.mask` 总是返回 null
   - 可能无法单独导出蒙版

2. **备选方案**：
   - 如果无法导出蒙版，用户只能用其他方式创建（系统工具/上传）
   - 或者在 Photopea 里手动合成到 Alpha 通道

---

*文档创建时间：2026-03-02*
*需求来源：与用户最终确认*
