# InpaintRegionEditor 开发日志

## 2026-03-03 选区约束 + MaskEditor 集成

### 完成的工作

1. **选区约束功能**
   - 选区必须框住蒙版区域
   - 选区不能超出图像边界
   - padding 改变时自动调整选区位置和大小
   - 统一 `constrainRegion()` 函数处理所有约束逻辑

2. **MaskEditor 集成**
   - 右键菜单添加 "Open in MaskEditor" 选项
   - 使用 `app.extensionManager.command.execute("Comfy.MaskEditor.OpenMaskEditor")` 调用系统命令
   - 解决 MaskEditor 返回后双图像问题（清除 `node.imgs`）
   - 解决 blob URL 不被 MaskEditor 接受的问题（使用原始 ComfyUI URL）

3. **UI 优化**
   - 移除红色蒙版区域显示（真实蒙版已在图像上显示）
   - 只保留橙色选区框

### 遇到的问题

1. **变量名冲突**：`beforeRegisterNodeDef(nodeType, nodeData)` 的参数 `nodeData` 覆盖了全局的 `nodeData` Map
   - 解决：全局变量改名为 `nodeImageData`

2. **`app.commands` undefined**：新版本 ComfyUI 命令系统变了
   - 解决：使用 `app.extensionManager.command.execute()`

3. **MaskEditor 不接受 blob URL**：
   - 解决：保存原始 ComfyUI URL (`/view?filename=...&type=...`)，点击菜单时用这个 URL 创建图像

4. **MaskEditor 返回后双图像**：
   - 解决：在 `onDrawBackground` 中检测并清除 `node.imgs`

### 关键代码

```javascript
// 统一的选区约束函数
function constrainRegion(data, padding) {
    // 1. 计算期望大小
    // 2. 约束不超过图像大小
    // 3. 约束不超出边界
    // 4. 优先框住蒙版
}

// 调用 MaskEditor
app.extensionManager.command.execute("Comfy.MaskEditor.OpenMaskEditor");
```

### 待解决问题

1. 选区大小调整（目前只能拖动位置，不能调整大小）
2. 多选区支持

---

## 2026-03-02 重大进展

### 完成的工作

1. **完全重写前端图像渲染**
   - 不再依赖 ComfyUI 的 `image_upload` 和 `node.imgs`
   - 自己加载图像、自己绘制
   - 去掉了 `nodes.py` 中的 `image_upload: True`

2. **选区框绘制正常工作**
   - 橙色选区框 + 红色遮罩区域
   - 标签显示尺寸

3. **拖动功能实现**
   - 关键发现：`onMouseDown(e, pos, canvas)` 的 `pos` 参数直接就是节点本地坐标
   - 不需要手动转换 `e.canvasX`
   - 返回 `true` 可以阻止节点被拖动

### 遇到的问题

1. **双图像问题**：ComfyUI 自动画了一个图，我又画了一个 → 去掉 `image_upload: True`

2. **黑边问题**：用黑色覆盖图像区域导致边框难看 → 直接画图像，不覆盖

3. **拖动不工作**：鼠标事件参数格式错误
   - 错误：`onMouseDown(e)` 以为 `e.canvasX` 是画布坐标
   - 正确：`onMouseDown(e, pos, canvas)`，`pos[0], pos[1]` 是节点本地坐标

### 待解决问题

1. 拖动体验优化（边界检测、视觉反馈）
2. 缩放/放大图像查看
3. Photopea 编辑后的图像刷新

### 代码结构

```
extension.js:
- loadImageAndDetectMask() - 加载图像并检测 Alpha 通道
- drawNode() - 绘制图像和选区框
- getImageDrawParams() - 计算图像绘制参数
- onMouseDown/Move/Up() - 拖动交互

nodes.py:
- INPUT_TYPES 去掉 image_upload
- process() 从 Alpha 提取 MASK
```

---

## 2026-02-28 研究结论（重要！续）

### 问题：发送给 Photopea 的图片带透明通道，导致遮罩混乱

**现象**：
- 发送给 Photopea 的图片有透明区域
- Photopea 保存后，LoadImage 节点的 MASK 输出变成乱码

**根因分析**：

1. LoadImage 节点处理流程（nodes.py:1732）：
   ```python
   image = i.convert("RGB")  # 丢弃 Alpha，返回纯 RGB
   ```
   → 这时候的 IMAGE 是**纯 RGB**，没有透明！

2. 但 `/view` API（server.py:528-546）默认行为：
   ```python
   if 'channel' not in request.rel_url.query:
       channel = 'rgba'  # 默认返回 RGBA！
   ```
   → 即使 LoadImage 输出的是纯 RGB，前端用 `/view?filename=...` 获取时，默认返回的是**原始文件**（可能带 Alpha）

3. 解决方案：加 `&channel=rgb` 参数
   ```
   /view?filename=xxx&type=input&channel=rgb
   ```
   → 服务器会用 Pillow 处理：
   ```python
   if channel == 'rgb':
       with Image.open(file) as img:
           if img.mode == "RGBA":
               r, g, b, a = img.split()
               new_img = Image.merge('RGB', (r, g, b))  # 丢弃 Alpha
           else:
               new_img = img.convert("RGB")
           new_img.save(buffer, format='PNG')
   ```

**最终代码修改**（extension.js）：
```javascript
// 错误的做法（默认返回 RGBA）：
var url = "/view?filename=" + encodeURIComponent(filename) + "&type=" + encodeURIComponent(type);

// 正确的做法（返回纯 RGB）：
var url = "/view?filename=" + encodeURIComponent(filename) + "&type=" + encodeURIComponent(type) + "&channel=rgb";
```

### 重要教训

1. **LoadImage 输出的 IMAGE 确实是纯 RGB**（Pillow convert("RGB") 处理过）
2. **但是 `/view` API 默认返回原始文件**（可能带 Alpha）
3. **必须加 `&channel=rgb` 参数** 才能获取纯 RGB 图片

---

## 2026-02-28 研究结论（重要！）

### 核心发现：ComfyUI 蒙版数据格式

## 2026-02-28 研究结论（重要！）

### 核心发现：ComfyUI 蒙版数据格式

通过分析 ComfyUI 源码，彻底理解了蒙版格式：

#### IMAGE 类型
```python
# nodes.py LoadImage.load_image()
image = i.convert("RGB")  # IMAGE 不含 Alpha！
# Shape: (B, H, W, 3), 值 [0, 1]
```

#### MASK 类型
```python
# nodes.py:1743-1745
if 'A' in i.getbands():
    mask = np.array(i.getchannel('A')).astype(np.float32) / 255.0
    mask = 1. - torch.from_numpy(mask)  # 反转！
# Shape: (B, H, W), 值 [0, 1]
# 1 = 遮罩区域, 0 = 背景
```

#### PNG Alpha → MASK 转换
```
PNG Alpha = 0 (透明)   → mask = 1.0 (遮罩区域)
PNG Alpha = 255 (不透明) → mask = 0.0 (背景)
```

#### /upload/mask API (server.py:462-474)
```python
original_pil = original_pil.convert('RGBA')
mask_pil = Image.open(image.file).convert('RGBA')
new_alpha = mask_pil.getchannel('A')  # 取上传图像的 Alpha
original_pil.putalpha(new_alpha)       # 替换原图 Alpha
```

### MaskToImage / ImageToMask 源码 (comfy_extras/nodes_mask.py)
```python
# MaskToImage: MASK → IMAGE
result = mask.reshape((-1, 1, H, W)).movedim(1, -1).expand(-1, -1, -1, 3)

# ImageToMask: IMAGE → MASK  
mask = image[:, :, :, channels.index(channel)]
```

### Photopea 关键发现

#### maskFromTransparency() 有 BUG - 会丢失透明区域的 RGB 数据
#### 正确方法：loadTransparentPixels() + addMask()
```javascript
doc.selection.loadTransparentPixels();  // 选择非透明区域
layer.addMask(true);                     // 创建图层蒙版
```

#### Photopea 蒙版语义 vs ComfyUI
| 系统 | 白色 | 黑色 |
|------|------|------|
| Photopea 蒙版 | 显示（非遮罩） | 隐藏（遮罩） |
| ComfyUI Mask | 遮罩区域 | 背景 |

### 完整数据流
```
传入图像 → 直接打开PNG → loadTransparentPixels + addMask → 图像完整 + 蒙版在图层右侧

导出蒙版 → 复制蒙版数据 → 反转（蒙版黑色=遮罩 → Alpha=0）→ PNG(RGB=0, Alpha)

上传蒙版 → POST /upload/mask → 服务端用蒙版Alpha替换原图Alpha
```

### 代码位置
- ComfyUI 核心: `E:\ComfyUI\nodes.py`, `E:\ComfyUI\server.py`
- 蒙版节点: `E:\ComfyUI\comfy_extras\nodes_mask.py`
- 参考实现: `E:\ComfyUI\custom_nodes\ComfyUI-Impact-Pack\js\impact-sam-editor.js`

---

## 2026-02-27

### 已完成
- 基础架构：Python 后端 + JS 前端
- Photopea iframe 集成
- 右键菜单 → Open in Photopea

### 技术参考
- Photopea Masks: https://www.photopea.com/learn/masks

### Photopea Layer Mask API (2026-02-28 更新)

#### 关键发现：layer.mask 返回 null - 已知限制

**Issue #7341** (2024年11月) 确认：layer masks 无法通过脚本 API 访问

```javascript
// 永远返回 null
var mask = layer.mask;
```

#### 但有 Workaround！

用户手动测试发现：`doc.activeChannel = layer.mask` 实际上能工作！

```javascript
// 虽然 layer.mask 返回 null，但这行代码实际能工作
doc.activeChannel = layer.mask;
```

#### 正确方案

用 try-catch 包裹，直接尝试导出：

```javascript
var exportScript = 
    '(function(){' +
    '  try {' +
    '    var doc = app.activeDocument;' +
    '    var layer = doc.activeLayer;' +
    '    var origChannel = doc.activeChannel;' +
    '    ' +
    '    doc.activeChannel = layer.mask;' +
    '    doc.selection.selectAll();' +
    '    doc.selection.copy();' +
    '    var newDoc = app.documents.add(doc.width, doc.height);' +
    '    app.activeDocument = newDoc;' +
    '    newDoc.paste();' +
    '    newDoc.saveToOE("png");' +
    '    newDoc.close(SaveOptions.DONOTSAVECHANGES);' +
    '    ' +
    '    app.activeDocument = doc;' +
    '    doc.activeChannel = origChannel;' +
    '    ' +
    '    app.echoToOE("mask_exported");' +
    '  } catch(e) {' +
    '    app.echoToOE("no_mask:" + e.message);' +
    '  }' +
    '})();';
```

#### 替代方案（如果上面不行）

用 visibility 切换导出带蒙版的图层：

```javascript
// 隐藏所有图层，只显示当前层（蒙版会自动应用）
for (var i = 0; i < app.activeDocument.layers.length; i++) {
    app.activeDocument.layers[i].visible = false;
}
app.activeDocument.activeLayer.visible = true;

// 导出 - 蒙版已经渲染进 PNG
app.activeDocument.saveToOE("png");
```
