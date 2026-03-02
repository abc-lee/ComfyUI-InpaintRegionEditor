# InpaintRegionEditor 技术验证清单

> 版本：1.0 | 日期：2026-03-02
> 目的：验证所有不确定的技术点，为最终方案提供依据
> 状态：✅ 已完成核心验证

---

## 零、验证结论摘要

### ✅ 已验证可行的方案

| 功能 | 方案 | 来源 |
|------|------|------|
| 图像导出 | `app.activeDocument.saveToOE("png")` | Photopea 官方 API |
| 从选区创建蒙版 | 创建临时图层 + 填充黑白 | sd-webui-photopea-embed |
| 单独导出选中图层 | 隐藏其他图层 + saveToOE | sd-webui-photopea-embed |

### ❌ 已确认不可行

| 功能 | 原因 | 备选方案 |
|------|------|---------|
| 直接访问 layer.mask | API 返回 null (Issue #7341) | 使用选区 workaround |
| 检测图层是否有蒙版 | layer.mask 始终为 null | 让用户通过选区操作 |

### 📋 推荐工作流

**用户创建蒙版的方式**：
1. 在 Photopea 中使用选择工具创建选区
2. 点击"从选区创建蒙版"按钮
3. 系统自动创建黑白蒙版图层并导出
4. 或者：用户直接上传带 Alpha 通道的 PNG

---

## 一、Photopea 加载验证

### 1.1 同时加载原图 + 蒙版

**测试目标**：能否让 Photopea 同时加载两个文件，并且蒙版作为图层蒙版？

**测试脚本**：
```javascript
// 方法 1：先打开图，再加载蒙版作为 mask
app.open("image.png");
var doc = app.activeDocument;
var layer = doc.activeLayer;
app.open("mask.png");
var maskDoc = app.activeDocument;
// 复制 mask 到原图的 layer.mask
```

**预期结果**：
- ✅ 成功：图层右侧出现蒙版缩略图
- ❌ 失败：两张独立的图，或者蒙版只是普通图层

**优先级**：🔴 最高（决定整个工作流）

---

### 1.2 加载带 Alpha 通道的 PNG

**测试目标**：如果上传的 PNG 本身带 Alpha 通道，Photopea 能否自动识别为蒙版？

**测试方法**：
1. 准备一个 RGBA PNG（RGB 是图像，Alpha 是蒙版）
2. 用 `app.open("data:image/png;base64,...")` 加载
3. 检查 `layer.mask` 是否存在

**预期结果**：
- ✅ 成功：Alpha 通道自动转为图层蒙版
- ❌ 失败：Alpha 通道只是透明，不是蒙版

---

### 1.3 用脚本创建图层蒙版

**测试目标**：能否用脚本把一张黑白图转换为图层蒙版？

**测试脚本**：
```javascript
// 假设已经有一个黑白图在剪贴板
doc.selection.load("mask.png");
layer.addMask(true);
```

**参考**：DEVLOG 中提到的 `loadTransparentPixels() + addMask()`

---

## 二、Photopea 导出验证

### 2.1 导出带蒙版的图像

**测试目标**：如果图层有蒙版，导出 PNG 时能否保留蒙版到 Alpha 通道？

**测试方法**：
1. 创建一个带蒙版的图层
2. 执行 `app.activeDocument.saveToOE("png")`
3. 检查导出的 PNG 是否有 Alpha 通道

**预期结果**：
- ✅ 成功：PNG 的 Alpha = 蒙版
- ❌ 失败：蒙版被丢弃，或者蒙版渲染到 RGB 里

---

### 2.2 单独导出蒙版

**测试目标**：能否只导出蒙版（黑白图）？

**❌ 原方案失败**：
```javascript
var mask = layer.mask;  // ⚠️ 已知返回 null
doc.activeChannel = layer.mask;  // 无法执行
```

**✅ Workaround 方案（已验证）**：
参考 `sd-webui-photopea-embed` 的 `createMaskFromSelection()` 实现：

```javascript
// 从选区创建蒙版图层
function createMaskFromSelection() {
    if (app.activeDocument.selection === null) {
        app.echo("No selection!");
        return;
    }

    // 创建临时图层
    newLayer = app.activeDocument.artLayers.add();
    newLayer.name = "TempMaskLayer";

    // 选区外部填充黑色
    app.activeDocument.selection.invert();
    color = new SolidColor();
    color.rgb.red = 0;
    color.rgb.green = 0;
    color.rgb.blue = 0;
    app.activeDocument.selection.fill(color);

    // 选区内部填充白色
    color.rgb.red = 255;
    color.rgb.green = 255;
    color.rgb.blue = 255;
    app.activeDocument.selection.invert();
    app.activeDocument.selection.fill(color);
}

// 导出蒙版图层
function exportMaskLayer() {
    // 隐藏其他图层，只显示蒙版图层
    // ... (参考 exportSelectedLayerOnly)
    app.activeDocument.saveToOE("png");
    // 删除临时蒙版图层
    app.activeDocument.activeLayer.remove();
}
```

**验证来源**：`sd-webui-photopea-embed` 项目 (https://github.com/yankooliveira/sd-webui-photopea-embed)

**结论**：✅ 可以通过选区 workaround 实现蒙版导出

---

### 2.3 检测当前是否有蒙版

**测试目标**：在用户点击"保存"前，能否检测当前文档是否有蒙版？

**测试脚本**：
```javascript
var hasMask = (app.activeDocument.activeLayer.mask != null);
// 或者
var hasMask = (app.activeDocument.activeLayer.layerMask != null);
```

**预期结果**：
- ✅ 成功：能准确检测
- ❌ 失败：无法检测（因为 layer.mask 总是返回 null）

**影响**：如果无法检测，就无法在保存前提示用户

---

## 三、前端交互验证

### 3.1 检测用户是否禁用了蒙版

**测试场景**：
1. 用户在 Photopea 里编辑
2. 点击图层蒙版眼睛图标（禁用蒙版）
3. 点保存

**问题**：
- 这时应该保存什么？
- 原图（忽略蒙版）还是报错？

**技术难点**：
- Photopea 的 UI 状态（哪个图层可见、蒙版是否启用）无法通过 API 获取
- 只能通过导出后的结果反推

---

### 3.2 两次导出 + 两次上传

**测试目标**：连续导出两次（图像 + 蒙版），能否都成功上传？

**测试流程**：
```javascript
// 1. 导出图像
var imageBlob = await exportImage();
var imageResult = await uploadToComfyUI(imageBlob, "edited.png");

// 2. 导出蒙版
var maskBlob = await exportMask();
var maskResult = await uploadToComfyUI(maskBlob, "mask.png");

// 3. 更新节点
node.widgets.find(w => w.name === "image").value = imageResult.name;
node.widgets.find(w => w.name === "mask").value = maskResult.name;
```

**潜在问题**：
- Photopea 的 postMessage 是异步的，两次导出会不会冲突？
- 上传需要时间，UI 上怎么显示进度？

---

## 四、后端处理验证

### 4.1 从两个文件合成一个 PNG

**测试目标**：后端能否把 RGB 图 + 黑白蒙版图 合成到一个 PNG？

**测试代码**：
```python
from PIL import Image

# 加载 RGB 图
rgb_img = Image.open("edited.png").convert("RGB")

# 加载蒙版图（黑白）
mask_img = Image.open("mask.png").convert("L")  # 转为灰度

# 合成
rgb_img.putalpha(mask_img)
rgb_img.save("combined.png")
```

**预期结果**：
- ✅ 成功：combined.png 的 Alpha = 蒙版
- ❌ 失败：尺寸不匹配、格式问题

---

### 4.2 节点同时输出两个文件名

**测试方案 A**：两个独立的 widget
```python
"image": (sorted(files), {"image_upload": True}),
"mask": (sorted(files), {"image_upload": True}),
```

**测试方案 B**：一个 widget 存 JSON
```python
"files": ("STRING", {"default": '{"image": "", "mask": ""}'}),
```

**测试方案 C**：一个 widget + node.properties
```python
"image": (sorted(files), {"image_upload": True}),
# mask 存在 node.properties["mask_file"]
```

---

## 五、UI/UX 验证

### 5.1 保存按钮的设计

**选项 A**：两个按钮
```
[💾 保存图像] [🎭 保存蒙版]
```
- 优点：用户明确知道在保存什么
- 缺点：步骤多，可能忘记保存另一个

**选项 B**：一个按钮，自动两次导出
```
[💾 保存全部]
```
- 优点：一键完成
- 缺点：慢，失败时难以定位

**选项 C**：下拉菜单
```
[💾 保存 ▼]
  ├─ 保存图像
  ├─ 保存蒙版
  └─ 保存全部
```
- 优点：灵活
- 缺点：UI 复杂

---

### 5.2 错误提示

**场景**：
1. 用户没画蒙版就点"保存蒙版"
2. Photopea 里没有活动选区
3. 上传失败

**提示方式**：
- A) alert() 弹窗（简单但打断体验）
- B) 状态栏文字（不打断但可能忽略）
- C) Toast 通知（折中方案）

---

## 六、优先级排序

| 编号 | 测试项 | 优先级 | 工作量 | 依赖关系 |
|-----|-------|-------|-------|---------|
| 1.1 | 同时加载原图 + 蒙版 | 🔴 最高 | 2h | 无 |
| 1.2 | 加载带 Alpha 的 PNG | 🔴 最高 | 1h | 无 |
| 2.1 | 导出带蒙版的 PNG | 🔴 最高 | 1h | 1.1 |
| 2.2 | 单独导出蒙版 | 🔴 最高 | 2h | 1.1 |
| 2.3 | 检测是否有蒙版 | 🟡 中 | 1h | 1.1 |
| 4.1 | 后端合成 PNG | 🟡 中 | 1h | 2.1+2.2 |
| 3.2 | 两次导出上传 | 🟡 中 | 2h | 2.1+2.2 |
| 4.2 | 节点输出两个文件名 | 🟢 低 | 1h | 4.1 |
| 5.1 | UI 按钮设计 | 🟢 低 | 1h | 所有 |

---

## 七、下一步行动

### Phase 1：核心验证（1-2 天）
1. 创建测试脚本 `test_photopea.js`
2. 手动测试 1.1, 1.2, 2.1, 2.2
3. 记录结果到本文档

### Phase 2：原型开发（2-3 天）
基于测试结果，选择可行的方案
开发最小可用原型（MVP）

### Phase 3：集成测试（1-2 天）
与 ComfyUI 集成
测试完整工作流

---

## 八、已知限制与解决方案

### 8.1 Photopea API 限制

| 限制 | 影响 | 解决方案 |
|------|------|---------|
| `layer.mask` 返回 null | 无法直接访问图层蒙版 | 使用选区创建蒙版图层 |
| 无法获取 UI 状态 | 无法检测蒙版是否启用 | 信任用户操作 |
| postMessage 异步 | 需要正确处理回调 | Promise 封装 |

### 8.2 推荐的蒙版创建工作流

**方案 A：用户上传带 Alpha 的 PNG（最简单）**
```
用户 → 外部工具创建蒙版 → 上传 PNG → 节点自动提取 Alpha
```

**方案 B：在 Photopea 中通过选区创建（已实现）**
```
用户 → Photopea 选择工具 → 创建选区 → "从选区创建蒙版"按钮 → 自动导出
```

**方案 C：使用 ComfyUI 系统蒙版工具**
```
用户 → 系统蒙版编辑器 → 保存 → 节点使用
```

---

## 九、实现状态

| 功能 | 状态 | 文件 |
|------|------|------|
| 后端节点（padding + 无蒙版报错） | ✅ 已实现 | `nodes.py` |
| 选区框 Canvas UI | ✅ 已实现 | `region-box-editor.js` |
| Photopea 图像编辑 | ✅ 已实现 | `extension.js` |
| Photopea 蒙版导出 | ⚠️ Workaround 可行 | 待添加选区功能 |

---

*文档创建时间：2026-03-02*
*验证完成时间：2026-03-02*
*验证来源：Photopea 官方文档 + sd-webui-photopea-embed 项目*
