# InpaintRegionEditor 详细实现计划

> 版本：6.0 | 更新时间：2026-02-27
> 基于 ULW 头脑风暴会话修订

---

## 一、核心概念

### 1.1 遮罩 vs 选区

| 概念 | 目的 | 作用 |
|------|------|------|
| **遮罩 (Mask)** | 定义重绘区域 | 重绘完成后，只在遮罩内部合成新内容 |
| **选区 (Region)** | 定义参考区域 | 大模型重绘时参考这个区域内的原图内容 |

### 1.2 工作原理

```
原始图像
┌─────────────────────────────────────────────────┐
│                                                 │
│    ┌─────────────────────────────────────┐     │
│    │ 选区 (参考区域) 1024×1024           │     │
│    │                                     │     │
│    │      ┌───────────────────┐         │     │
│    │      │ 遮罩 (重绘区域)   │         │     │
│    │      │ 512×512          │         │     │
│    │      │                   │         │     │
│    │      └───────────────────┘         │     │
│    │                                     │     │
│    └─────────────────────────────────────┘     │
│                                                 │
└─────────────────────────────────────────────────┘

重绘流程：
1. 大模型参考选区内的原图内容
2. 重绘整个选区区域
3. 根据遮罩合成：只在遮罩内放入新内容

关键约束：选区必须 ≥ 遮罩
```

---

## 二、用户工作流程

```
1. 用户添加 InpaintRegionEditor 节点
2. 上传图像
3. 右键 → Open in Photopea
4. 在 Photopea 中：
   a. 编辑图像（液化、仿制图章等）- 可选
   b. 绘制遮罩（定义要重绘的区域）
5. 保存返回节点
6. 节点显示：
   - 编辑后的图像预览
   - 遮罩预览（半透明红色）
   - 遮罩边界信息：宽×高
7. 用户选择选区尺寸：
   - 预设：512×512 (SD), 1024×1024 (SDXL) 等
   - 自定义输入
   - ⚠️ 自动验证：选区必须 ≥ 遮罩
8. 选区自动居中于遮罩
9. 执行工作流 → 输出图像、遮罩、选区坐标
```

---

## 三、文件结构

```
ComfyUI-InpaintRegionEditor/
├── __init__.py                 # 节点注册
├── nodes.py                    # 后端节点定义
│
└── web/
    ├── extension.js            # 扩展入口 + 右键菜单
    ├── photopea-modal.js       # Photopea 全屏对话框
    ├── photopea-bridge.js      # Photopea postMessage 通信
    └── style.css               # 样式
```

---

## 四、后端实现

### 4.1 `__init__.py`

```python
"""
@author: Your Name
@title: Inpaint Region Editor
@description: Enhanced mask editor with Photopea integration and configurable inpaint region
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

### 4.2 `nodes.py`

```python
import torch
import numpy as np
import folder_paths
from PIL import Image
import os
import json

class InpaintRegionEditor:
    """
    增强版遮罩编辑器，支持 Photopea 集成和可配置选区
    
    概念说明：
    - 遮罩 (Mask): 定义重绘区域，重绘完成后只在遮罩内合成新内容
    - 选区 (Region): 定义参考区域，大模型重绘时参考这个区域内的原图内容
    
    约束：选区必须 >= 遮罩
    """
    
    # 预设尺寸映射
    PRESET_SIZES = {
        "512×512 (SD)": (512, 512),
        "768×768": (768, 768),
        "1024×1024 (SDXL)": (1024, 1024),
        "1280×1280": (1280, 1280),
        "1536×1536": (1536, 1536),
    }
    
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
                
                # 选区尺寸预设
                "region_size": (
                    list(s.PRESET_SIZES.keys()) + ["Custom (自定义)"],
                    {"default": "512×512 (SD)"}
                ),
                
                # 自定义选区尺寸
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
            },
            "hidden": {
                # 遮罩边界信息（前端传递）
                "mask_bounds": "STRING",
            }
        }
    
    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "region_top", "region_left", "region_width", "region_height")
    FUNCTION = "process"
    CATEGORY = "image/inpaint"
    
    def process(self, image, region_size, region_width, region_height, 
                mask_bounds=None):
        """
        处理图像和遮罩，计算选区位置
        
        Args:
            image: 图像文件名
            region_size: 选区预设名称
            region_width: 自定义选区宽度
            region_height: 自定义选区高度
            mask_bounds: 遮罩边界 JSON 字符串
        """
        # 加载图像
        image_path = folder_paths.get_annotated_filepath(image)
        img = Image.open(image_path)
        
        img_width, img_height = img.size
        
        # 提取或创建遮罩
        if 'A' in img.getbands():
            mask = np.array(img.getchannel('A')).astype(np.float32) / 255.0
            mask = 1.0 - mask  # ComfyUI 遮罩约定
        else:
            mask = np.zeros((img_height, img_width), dtype=np.float32)
        
        # 解析遮罩边界
        mask_bounds_dict = None
        if mask_bounds:
            try:
                mask_bounds_dict = json.loads(mask_bounds)
            except:
                pass
        
        # 如果没有前端传递的遮罩边界，自动计算
        if not mask_bounds_dict:
            mask_bounds_dict = self._calculate_mask_bounds(mask)
        
        # 确定选区尺寸
        if region_size in self.PRESET_SIZES:
            r_width, r_height = self.PRESET_SIZES[region_size]
        else:
            r_width, r_height = region_width, region_height
        
        # 约束验证：选区必须 >= 遮罩
        mask_w = mask_bounds_dict.get('width', 0)
        mask_h = mask_bounds_dict.get('height', 0)
        
        if r_width < mask_w:
            r_width = mask_w
        if r_height < mask_h:
            r_height = mask_h
        
        # 计算选区位置（居中于遮罩）
        mask_x = mask_bounds_dict.get('x', 0)
        mask_y = mask_bounds_dict.get('y', 0)
        
        region_x = mask_x + mask_w / 2 - r_width / 2
        region_y = mask_y + mask_h / 2 - r_height / 2
        
        # 确保选区在图像范围内
        region_x = max(0, min(region_x, img_width - r_width))
        region_y = max(0, min(region_y, img_height - r_height))
        
        # 转换为 tensor
        image_tensor = torch.from_numpy(
            np.array(img.convert("RGB")).astype(np.float32) / 255.0
        ).unsqueeze(0)
        
        mask_tensor = torch.from_numpy(mask).unsqueeze(0)
        
        return (
            image_tensor, 
            mask_tensor, 
            int(region_y),  # top
            int(region_x),  # left
            int(r_width), 
            int(r_height)
        )
    
    def _calculate_mask_bounds(self, mask):
        """计算遮罩的边界框"""
        rows = np.any(mask > 0.5, axis=1)
        cols = np.any(mask > 0.5, axis=0)
        
        if not np.any(rows) or not np.any(cols):
            return {'x': 0, 'y': 0, 'width': 0, 'height': 0}
        
        rmin, rmax = np.where(rows)[0][[0, -1]]
        cmin, cmax = np.where(cols)[0][[0, -1]]
        
        return {
            'x': int(cmin),
            'y': int(rmin),
            'width': int(cmax - cmin + 1),
            'height': int(rmax - rmin + 1)
        }
```

---

## 五、前端实现

### 5.1 `web/extension.js`

```javascript
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { PhotopeaModal } from "./photopea-modal.js";

app.registerExtension({
    name: "comfyui.inpaint_region_editor",
    
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "InpaintRegionEditor") return;
        
        // 添加右键菜单项
        const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function(canvas, options) {
            getExtraMenuOptions?.apply(this, arguments);
            
            const node = this;
            
            options.push(null); // 分隔线
            
            options.push({
                content: "🎨 Open in Photopea",
                callback: () => {
                    const imageWidget = node.widgets?.find(w => w.name === 'image');
                    if (imageWidget?.value) {
                        PhotopeaModal.show(node, imageWidget.value);
                    } else {
                        alert("请先上传图像！");
                    }
                }
            });
            
            return options;
        };
        
        // 节点创建时添加遮罩边界 widget
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            const result = onNodeCreated?.apply(this, arguments) ?? undefined;
            
            // 隐藏的遮罩边界 widget
            this.addWidget("STRING", "mask_bounds", "{}", () => {}, { serialize: true });
            
            return result;
        };
    }
});
```

### 5.2 `web/photopea-modal.js`

```javascript
import { PhotopeaBridge } from "./photopea-bridge.js";

export class PhotopeaModal {
    static instance = null;
    static node = null;
    static maskBounds = null;
    
    // 选区预设尺寸
    static REGION_PRESETS = {
        "512×512 (SD)": { width: 512, height: 512 },
        "768×768": { width: 768, height: 768 },
        "1024×1024 (SDXL)": { width: 1024, height: 1024 },
        "1280×1280": { width: 1280, height: 1280 },
        "1536×1536": { width: 1536, height: 1536 },
    };
    
    static show(node, imagePath) {
        this.node = node;
        this.maskBounds = null;
        this.createUI();
        this.loadImage(imagePath);
    }
    
    static createUI() {
        // 移除已存在的 modal
        this.modal?.remove();
        
        this.modal = document.createElement('div');
        this.modal.className = 'photopea-modal';
        this.modal.innerHTML = `
            <div class="photopea-container">
                <iframe id="photopea-iframe" src="https://www.photopea.com/"></iframe>
                <div class="photopea-toolbar">
                    <div class="toolbar-left">
                        <span class="toolbar-hint">💡 提示：在 Photopea 中绘制遮罩（要重绘的区域）</span>
                    </div>
                    <div class="toolbar-right">
                        <button id="btn-get-mask" class="btn btn-primary">📐 从选区获取遮罩</button>
                        <button id="btn-save" class="btn btn-success">💾 保存到节点</button>
                        <button id="btn-cancel" class="btn btn-secondary">❌ 取消</button>
                    </div>
                </div>
                <div class="photopea-statusbar">
                    <span id="status-text">正在加载 Photopea...</span>
                    <span id="mask-info" style="display:none;">遮罩: <span id="mask-size">-</span></span>
                </div>
            </div>
        `;
        
        document.body.appendChild(this.modal);
        
        // 初始化 PhotopeaBridge
        const iframe = document.getElementById('photopea-iframe');
        iframe.onload = () => {
            PhotopeaBridge.init(iframe);
            document.getElementById('status-text').textContent = 'Photopea 已就绪';
        };
        
        this.setupEventListeners();
    }
    
    static setupEventListeners() {
        // 从选区获取遮罩
        document.getElementById('btn-get-mask').addEventListener('click', async () => {
            try {
                const bounds = await PhotopeaBridge.getSelectionBounds();
                if (bounds) {
                    this.maskBounds = bounds;
                    document.getElementById('mask-info').style.display = 'inline';
                    document.getElementById('mask-size').textContent = 
                        `${bounds.width}×${bounds.height}`;
                    document.getElementById('status-text').textContent = 
                        `✅ 已获取遮罩边界：(${bounds.x}, ${bounds.y}) ${bounds.width}×${bounds.height}`;
                } else {
                    alert('请先在 Photopea 中创建选区！');
                }
            } catch (e) {
                alert('获取选区失败：' + e.message);
            }
        });
        
        // 保存到节点
        document.getElementById('btn-save').addEventListener('click', async () => {
            await this.saveToNode();
        });
        
        // 取消
        document.getElementById('btn-cancel').addEventListener('click', () => {
            this.close();
        });
    }
    
    static async loadImage(imagePath) {
        try {
            const response = await fetch(`/view?filename=${imagePath}&type=input`);
            const blob = await response.blob();
            await PhotopeaBridge.openImage(blob);
            document.getElementById('status-text').textContent = '图像已加载，请在 Photopea 中编辑并创建选区';
        } catch (e) {
            document.getElementById('status-text').textContent = '加载图像失败：' + e.message;
        }
    }
    
    static async saveToNode() {
        if (!this.maskBounds) {
            // 尝试获取当前选区作为遮罩
            try {
                const bounds = await PhotopeaBridge.getSelectionBounds();
                if (bounds) {
                    this.maskBounds = bounds;
                } else {
                    alert('请先创建选区作为遮罩！');
                    return;
                }
            } catch (e) {
                alert('请先创建选区作为遮罩！');
                return;
            }
        }
        
        try {
            document.getElementById('status-text').textContent = '正在导出图像和遮罩...';
            
            // 导出图像和遮罩
            const { image, mask } = await PhotopeaBridge.exportImageAndMask();
            
            // 上传到 ComfyUI
            const imageResult = await this.uploadToComfyUI(image, 'edited_image.png');
            const maskResult = await this.uploadToComfyUI(mask, 'mask.png');
            
            // 更新节点
            const imageWidget = this.node.widgets?.find(w => w.name === 'image');
            const maskBoundsWidget = this.node.widgets?.find(w => w.name === 'mask_bounds');
            
            if (imageWidget) {
                imageWidget.value = imageResult.name;
            }
            
            if (maskBoundsWidget) {
                maskBoundsWidget.value = JSON.stringify(this.maskBounds);
            }
            
            this.node.setDirtyCanvas(true);
            
            document.getElementById('status-text').textContent = '✅ 已保存到节点';
            
            setTimeout(() => this.close(), 500);
            
        } catch (e) {
            alert('保存失败：' + e.message);
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
        this.maskBounds = null;
    }
}
```

### 5.3 `web/photopea-bridge.js`

```javascript
/**
 * Photopea 通信桥接
 * 安全地处理与 Photopea iframe 的 postMessage 通信
 */
export class PhotopeaBridge {
    static iframe = null;
    static photopeaWindow = null;
    
    // 安全：只接受来自 photopea.com 的消息
    static PHOTOPEA_ORIGIN = "https://www.photopea.com";
    
    static init(iframe) {
        this.iframe = iframe;
        this.photopeaWindow = iframe.contentWindow;
    }
    
    /**
     * 发送消息到 Photopea 并等待响应
     * @param {string|ArrayBuffer} message - 要发送的消息
     * @returns {Promise<Array>} 响应数组
     */
    static async postMessage(message) {
        return new Promise((resolve, reject) => {
            if (!this.photopeaWindow) {
                reject(new Error('Photopea not initialized'));
                return;
            }
            
            const responses = [];
            
            const handler = (event) => {
                // ✅ 安全验证：只接受来自 photopea.com 的消息
                if (event.origin !== this.PHOTOPEA_ORIGIN) {
                    console.warn('[PhotopeaBridge] Ignored message from unknown origin:', event.origin);
                    return;
                }
                
                responses.push(event.data);
                
                if (event.data === "done") {
                    window.removeEventListener("message", handler);
                    resolve(responses);
                }
            };
            
            window.addEventListener("message", handler);
            
            // 发送消息（"*" 用于发送是可接受的）
            this.photopeaWindow.postMessage(message, "*");
            
            // 超时处理
            setTimeout(() => {
                window.removeEventListener("message", handler);
                reject(new Error('Photopea timeout (60s)'));
            }, 60000);
        });
    }
    
    /**
     * 打开图像到 Photopea
     * @param {Blob} blob - 图像 Blob
     */
    static async openImage(blob) {
        const base64 = await this.blobToBase64(blob);
        await this.postMessage(`app.open("${base64}", null, false);`);
        await this.postMessage(`app.activeDocument.activeLayer.rasterize();`);
    }
    
    /**
     * 获取选区边界
     * @returns {Object|null} { x, y, width, height } 或 null（无选区）
     */
    static async getSelectionBounds() {
        try {
            const result = await this.postMessage(
                'app.echoToOE(app.activeDocument.selection.bounds);'
            );
            
            if (result[0] && typeof result[0] === 'string') {
                const [left, top, right, bottom] = result[0].split(',').map(Number);
                return {
                    x: left,
                    y: top,
                    width: right - left,
                    height: bottom - top
                };
            }
            return null;
        } catch (e) {
            return null;
        }
    }
    
    /**
     * 从选区创建遮罩并导出图像和遮罩
     * @returns {Object} { image: Blob, mask: Blob }
     */
    static async exportImageAndMask() {
        // 导出原图
        const imageResult = await this.postMessage('app.activeDocument.saveToOE("png");');
        const imageArrayBuffer = imageResult.find(r => r instanceof ArrayBuffer);
        const imageBlob = new Blob([imageArrayBuffer], { type: 'image/png' });
        
        // 创建遮罩
        const createMaskScript = `
            (function() {
                var doc = app.activeDocument;
                if (!doc.selection.bounds) return;
                
                // 创建遮罩图层
                var maskLayer = doc.artLayers.add();
                maskLayer.name = "TempMaskLayer";
                
                // 反选填充黑色
                doc.selection.invert();
                var black = new SolidColor();
                black.rgb.red = 0;
                black.rgb.green = 0;
                black.rgb.blue = 0;
                doc.selection.fill(black);
                
                // 恢复选区填充白色
                doc.selection.invert();
                var white = new SolidColor();
                white.rgb.red = 255;
                white.rgb.green = 255;
                white.rgb.blue = 255;
                doc.selection.fill(white);
                
                // 导出
                doc.saveToOE("png");
                
                // 删除临时图层
                maskLayer.remove();
            })();
        `;
        
        const maskResult = await this.postMessage(createMaskScript);
        const maskArrayBuffer = maskResult.find(r => r instanceof ArrayBuffer);
        const maskBlob = new Blob([maskArrayBuffer], { type: 'image/png' });
        
        return { image: imageBlob, mask: maskBlob };
    }
    
    /**
     * Blob 转 Base64
     */
    static blobToBase64(blob) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
        });
    }
}
```

### 5.4 `web/style.css`

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
    padding: 10px 15px;
    background: #2d2d2d;
    border-top: 1px solid #444;
}

.toolbar-left {
    display: flex;
    align-items: center;
    gap: 10px;
}

.toolbar-right {
    display: flex;
    align-items: center;
    gap: 10px;
}

.toolbar-hint {
    color: #888;
    font-size: 13px;
}

.btn {
    padding: 8px 16px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
    transition: background 0.2s;
}

.btn-primary {
    background: #0078d4;
    color: white;
}

.btn-primary:hover {
    background: #106ebe;
}

.btn-success {
    background: #107c10;
    color: white;
}

.btn-success:hover {
    background: #0b5c0b;
}

.btn-secondary {
    background: #555;
    color: white;
}

.btn-secondary:hover {
    background: #666;
}

.photopea-statusbar {
    display: flex;
    justify-content: space-between;
    padding: 8px 15px;
    background: #1a1a1a;
    color: #888;
    font-size: 12px;
}
```

---

## 六、关键安全措施

### 6.1 postMessage 安全验证

```javascript
// ✅ 正确：验证消息来源
const handler = (event) => {
    if (event.origin !== "https://www.photopea.com") {
        return; // 忽略非 Photopea 来源的消息
    }
    // 处理消息...
};
```

### 6.2 超时处理

```javascript
// 防止无限等待
setTimeout(() => {
    window.removeEventListener("message", handler);
    reject(new Error('Photopea timeout'));
}, 60000);
```

### 6.3 错误处理

```javascript
try {
    const result = await PhotopeaBridge.postMessage(message);
    // 处理结果...
} catch (e) {
    alert('操作失败：' + e.message);
}
```

---

## 七、约束验证

### 7.1 选区必须 >= 遮罩

```javascript
// 前端验证
function validateRegionSize(maskBounds, regionWidth, regionHeight) {
    if (regionWidth < maskBounds.width || regionHeight < maskBounds.height) {
        return {
            valid: false,
            message: `选区太小！必须 ≥ 遮罩 (${maskBounds.width}×${maskBounds.height})`
        };
    }
    return { valid: true };
}

// 后端验证（Python）
if r_width < mask_w:
    r_width = mask_w  # 自动扩大
if r_height < mask_h:
    r_height = mask_h
```

---

## 八、实现检查清单

- [ ] `__init__.py` - 节点注册
- [ ] `nodes.py` - 后端节点逻辑
- [ ] `extension.js` - 右键菜单集成
- [ ] `photopea-modal.js` - 全屏对话框
- [ ] `photopea-bridge.js` - 通信桥接
- [ ] `style.css` - 样式
- [ ] 测试：图像上传
- [ ] 测试：Photopea 打开
- [ ] 测试：遮罩创建
- [ ] 测试：选区验证
- [ ] 测试：保存到节点

---

## 九、参考资源

- **Photopea API**: https://www.photopea.com/api
- **sd-webui-photopea-embed**: https://github.com/yankooliveira/sd-webui-photopea-embed
- **stable-diffusion-ps-pea** (推荐): https://github.com/huchenlei/stable-diffusion-ps-pea
- **ComfyUI Impact-Pack**: E:\ComfyUI\custom_nodes\ComfyUI-Impact-Pack\

---

*文档版本: 6.0 | 更新时间: 2026-02-27*
*基于 ULW 头脑风暴会话修订*
