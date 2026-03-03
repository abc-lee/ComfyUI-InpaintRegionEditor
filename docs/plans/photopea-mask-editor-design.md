# Photopea 蒙版编辑方案设计

> 版本：1.0 | 创建时间：2026-03-03

---

## 一、问题背景

### 1.1 Photopea 导出透明图像的问题

**现象**：
- 用户在 Photopea 中用橡皮擦创建透明区域
- 导出 PNG 时，透明区域的 RGB 数据丢失（变成黑色）
- 只有 Alpha 通道信息，RGB 被"掏空"

**原因**：
- Photopea 的 `saveToOE("png")` 不支持"extra channel as opacity"参数
- 透明区域的 RGB 默认被丢弃

### 1.2 之前失败的尝试

- 直接传入带 Alpha 的 PNG → 导出后 RGB 丢失
- 尝试从透明度创建蒙版 → `layer.mask` 返回 null（API 限制）
- 官方"extra channel as opacity"方案 → 只支持手动操作，不支持脚本 API

---

## 二、解决方案

### 2.1 核心思路

**分离图像编辑和蒙版编辑为两个独立功能**：
- 图像编辑：只处理 RGB，不涉及蒙版
- 蒙版编辑：单独处理蒙版层，避免 RGB 丢失问题

### 2.2 图层结构

```
Photopea 图层面板：
┌─────────────────────────────┐
│ 蒙版层（最上层，默认选中）    │  ← 用户在此绘制
│   - 灰度图：黑色=遮罩        │
│   - 灰色=羽化边缘            │
│   - 白色/透明=不遮罩         │
├─────────────────────────────┤
│ 图像层（参考底图）           │  ← 用户可见，作为参考
└─────────────────────────────┘
```

### 2.3 用户操作流程

**新建蒙版**：
1. 右键 → "编辑蒙版（Photopea）"
2. Photopea 打开，显示图像层 + 透明蒙版层
3. 用户在蒙版层上绘制（建议用黑色画笔）
4. 点击保存
5. 只导出蒙版层的灰度数据
6. 更新节点的蒙版

**编辑已有蒙版**：
1. 后端从图像 Alpha 通道提取现有蒙版
2. 转换为灰度图（透明→黑色，不透明→白色，半透明→灰色）
3. 传入 Photopea
4. 用户修改
5. 保存并更新

---

## 三、技术实现

### 3.1 右键菜单

```javascript
options.push({
    content: "编辑图像（Photopea）",
    callback: () => openPhotopeaForImage(node)
});
options.push({
    content: "编辑蒙版（Photopea）",
    callback: () => openPhotopeaForMask(node)
});
```

### 3.2 传入 Photopea

```javascript
async function openPhotopeaForMask(node) {
    // 1. 获取图像数据
    const imageBlob = await getImageBlob(node);
    
    // 2. 获取或创建蒙版
    let maskBlob;
    if (hasExistingMask(node)) {
        maskBlob = await extractMaskFromAlpha(node);
    } else {
        maskBlob = await createTransparentMask(node);
    }
    
    // 3. 先打开图像（作为底层）
    await photopea.postMessage(`app.open("data:image/png;base64,${imageBase64}", null, false);`);
    
    // 4. 再打开蒙版（作为上层，会被选中）
    await photopea.postMessage(`app.open("data:image/png;base64,${maskBase64}", null, true);`);
    
    // 5. 命名图层（可选）
    await photopea.postMessage(`
        app.activeDocument.activeLayer.name = "蒙版层";
        app.activeDocument.layers[1].name = "图像层";
    `);
}
```

### 3.3 导出蒙版

```javascript
async function exportMaskFromPhotopea() {
    const script = `
        // 隐藏图像层，只显示蒙版层
        for (var i = 0; i < app.activeDocument.layers.length; i++) {
            app.activeDocument.layers[i].visible = (i === 0);
        }
        // 导出蒙版层
        app.activeDocument.saveToOE("png");
    `;
    
    const result = await photopea.postMessage(script);
    const maskBlob = extractArrayBuffer(result);
    
    // 上传并更新节点
    await uploadMask(maskBlob);
}
```

### 3.4 灰度转蒙版

```javascript
// 前端或后端处理
// 灰度值 0（黑）→ mask = 1.0（完全遮罩）
// 灰度值 255（白）→ mask = 0.0（不遮罩）
// 灰度值 128（灰）→ mask = 0.5（羽化）

function grayscaleToMask(imageData) {
    const pixels = imageData.data;
    const mask = new Float32Array(pixels.length / 4);
    
    for (let i = 0; i < mask.length; i++) {
        const r = pixels[i * 4];
        const g = pixels[i * 4 + 1];
        const b = pixels[i * 4 + 2];
        const gray = (r + g + b) / 3;
        mask[i] = 1.0 - (gray / 255.0);  // 黑色=遮罩
    }
    
    return mask;
}
```

---

## 四、数据流

### 4.1 传入流程

```
ComfyUI 节点
    │
    ├─ 图像数据 ──────────────────┐
    │                            │
    └─ 已有蒙版？                 │
         │                       │
         ├─ 是：从 Alpha 提取     │
         │   透明→黑色            │
         │   不透明→白色          │
         │   半透明→灰色          │
         │                       │
         └─ 否：创建透明图层      │
                                 │
                                 ▼
                         Photopea
                         ├─ 图像层（底层）
                         └─ 蒙版层（上层，选中）
```

### 4.2 导出流程

```
Photopea
    │
    │ 用户绘制蒙版（黑/灰/白）
    │
    ▼
导出蒙版层灰度图
    │
    │ 灰度 → mask 值
    │ 黑色(0) → 1.0（遮罩）
    │ 白色(255) → 0.0（不遮罩）
    │ 灰色(128) → 0.5（羽化）
    │
    ▼
上传到 ComfyUI
    │
    ▼
更新节点图像
    │
    │ 将蒙版作为 Alpha 通道
    │ 合并到原图
    │
    ▼
节点显示更新
```

---

## 五、UI 提示

### 5.1 状态栏文字

```
"编辑蒙版模式：用黑色画笔绘制遮罩区域，灰色可产生羽化边缘。保存时只导出蒙版。"
```

### 5.2 图层命名

- 蒙版层：`蒙版（编辑此层）`
- 图像层：`参考图像`

---

## 六、边界情况

### 6.1 空图像

- 提示用户先上传图像

### 6.2 图像尺寸变化

- 蒙版层尺寸应与图像一致
- 导出时验证尺寸

### 6.3 用户误操作

- 用户可能编辑了图像层而非蒙版层
- 保存时只导出蒙版层，忽略图像层变化

---

## 七、与现有功能的关系

### 7.1 编辑图像（Photopea）

- 现有功能保持不变
- 只处理 RGB 图像
- 不涉及蒙版

### 7.2 编辑蒙版（Photopea）

- 新增功能
- 处理蒙版层
- 保持 RGB 不变

### 7.3 Open in MaskEditor

- 系统蒙版编辑器
- 作为备选方案保留

---

## 八、实现检查清单

- [ ] 右键菜单添加"编辑蒙版"选项
- [ ] 实现分离 Alpha 为灰度蒙版
- [ ] 实现创建透明蒙版层
- [ ] 实现传入两个图层到 Photopea
- [ ] 实现只导出蒙版层
- [ ] 实现灰度转 ComfyUI 蒙版格式
- [ ] 更新状态栏提示
- [ ] 测试新建蒙版流程
- [ ] 测试编辑已有蒙版流程
- [ ] 测试羽化边缘效果

---

## 九、参考资源

- Photopea API: https://www.photopea.com/api/
- Photopea Scripts: https://www.photopea.com/learn/scripts
- Issue #7488: 分别导出图层
- `app.open(url, as, asSmart)` API

---

*文档版本: 1.0 | 创建时间: 2026-03-03*
