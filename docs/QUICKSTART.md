# 快速开始指南

> 给接手团队的 5 分钟快速了解

---

## 1. 这个项目是做什么的？

**一句话**：ComfyUI 局部重绘的增强编辑器

**三个功能**：
1. **图像编辑**：集成 Photopea（在线 PS），实现液化、仿制图章等功能
2. **蒙版编辑**：在 Photopea 里画复杂的蒙版（羽化、透明度等）
3. **选区调整**：手动拖动参考区域位置（原有功能只能中心扩散）

---

## 2. 核心需求（必须实现）

```
用户上传图像 → 自动检测蒙版（Alpha 通道）
            ↓
         没有蒙版？→ 报错："请先创建蒙版"
            ↓
         有蒙版？→ 自动计算选区 = 遮罩边界 + padding
            ↓
   在图像预览上绘制：
   - 遮罩（半透明红）
   - 选区框（橙色虚线，可拖动）
            ↓
   输出：IMAGE, MASK, region_top, region_left, region_width, region_height
```

**关键点**：
- 蒙版从 Alpha 通道提取
- 没蒙版就报错（局部重绘必须有蒙版）
- 选区是矩形框，必须框住遮罩
- 用户可以拖动选区位置

---

## 3. 文件结构

```
InpaintRegionEditor/
├── nodes.py                 # ⭐ 后端核心（优先实现）
├── __init__.py              # 节点注册
│
├── web/
│   ├── extension.js         # 前端入口
│   ├── region-box-editor.js # ⭐ 选区框绘制（优先实现）
│   ├── photopea-modal.js    # Photopea 对话框
│   └── photopea-bridge.js   # Photopea 通信
│
└── docs/
    ├── HANDOFF.md           # ⭐ 完整交接文档（最重要）
    ├── implementation-plan.md # 详细实现方案
    └── technical-validation.md # 技术验证清单
```

---

## 4. 开发顺序建议

### 第一步：后端基础（1 天）
```bash
# 修改 nodes.py
1. 实现 INPUT_TYPES（image + padding 参数）
2. 实现 process 函数：
   - 加载图像
   - 提取 Alpha → MASK
   - 计算遮罩边界
   - 计算选区 = 遮罩边界 + padding
   - 输出 region_*
3. 测试：上传带 Alpha 的 PNG → 验证输出
```

### 第二步：选区 UI（2 天）
```bash
# 创建 region-box-editor.js
参考：ComfyUI-Impact-Pack/js/mask-rect-area.js

功能：
1. 在节点 Canvas 上绘制遮罩（半透明红）
2. 在节点 Canvas 上绘制选区框（橙色虚线）
3. 实现鼠标拖动选区框
4. 同步坐标到 hidden widget
```

### 第三步：Photopea 集成（2-3 天）
```bash
# 创建 photopea-modal.js + photopea-bridge.js
功能：
1. 右键菜单 → 打开全屏 Photopea
2. 加载图像到 Photopea
3. 导出图像回传
4. ⚠️ 导出蒙版（待验证，可能无法实现）
```

---

## 5. 技术要点速查

### 5.1 蒙版提取（Python）
```python
if 'A' in img.getbands():
    mask = np.array(img.getchannel('A')).astype(np.float32) / 255.0
    mask = 1.0 - mask  # 反转：1=遮罩区域
else:
    raise ValueError("请先创建蒙版")
```

### 5.2 选区计算（Python）
```python
def _calculate_region_rect(mask_bounds, padding):
    return {
        'x': mask_bounds['x'] - padding,
        'y': mask_bounds['y'] - padding,
        'width': mask_bounds['width'] + padding * 2,
        'height': mask_bounds['height'] + padding * 2
    }
```

### 5.3 Photopea 通信（JavaScript）
```javascript
// 发送
photopeaWindow.postMessage('app.activeDocument.saveToOE("png");', "*");

// 接收（验证 origin）
window.addEventListener("message", (event) => {
    if (event.origin !== "https://www.photopea.com") return;
    // 处理...
});
```

### 5.4 图像加载（JavaScript）
```javascript
// ⚠️ 关键：加 &channel=rgb 获取纯 RGB
const response = await fetch(`/view?filename=${imagePath}&type=input&channel=rgb`);
```

---

## 6. 待验证的技术点

### 高优先级（决定方案）
- [ ] **P1**: Photopea 能否单独导出蒙版？
- [ ] **P2**: Photopea 能否同时加载原图 + 蒙版？

**验证方法**：
```javascript
// 在 Photopea 控制台测试
app.activeDocument.activeLayer.mask;  // 返回 null（已知限制）

// Workaround
doc.activeChannel = layer.mask;  // 可能工作
```

**备选方案**：
- 如果不能导出蒙版 → 用户用其他方式创建（系统工具/上传）

---

## 7. 参考代码位置

| 功能 | 参考文件 | 路径 |
|------|---------|------|
| 选区框绘制 | `mask-rect-area.js` | `E:\ComfyUI\custom_nodes\ComfyUI-Impact-Pack\js\` |
| 图像加载 | `nodes.py` (LoadImage) | `E:\ComfyUI\nodes.py` (line 1702) |
| 上传 API | `server.py` | `E:\ComfyUI\server.py` |

---

## 8. 常见错误

### 错误 1：没有蒙版
```python
# ❌ 错误：返回全黑蒙版
mask = torch.zeros((64,64), dtype=torch.float32, device="cpu")

# ✅ 正确：报错
raise ValueError("请先创建蒙版（局部重绘需要蒙版）")
```

### 错误 2：选区小于遮罩
```python
# ❌ 错误：静默修正
region_width = max(region_width, mask_width)

# ✅ 正确：报错
if region_width < mask_width:
    raise ValueError("选区必须 >= 遮罩")
```

### 错误 3：Photopea 消息验证
```javascript
// ❌ 错误：不验证 origin
window.addEventListener("message", handler);

// ✅ 正确：验证 origin
window.addEventListener("message", (event) => {
    if (event.origin !== "https://www.photopea.com") return;
    // 处理...
});
```

---

## 9. 测试清单

### 后端测试
- [ ] 上传带 Alpha 的 PNG → 正确提取 MASK
- [ ] 上传不带 Alpha 的 PNG → 报错
- [ ] padding = 64 → 选区正确计算
- [ ] 拖动选区后 → 坐标正确传递

### 前端测试
- [ ] 节点显示遮罩预览（半透明红）
- [ ] 节点显示选区框（橙色虚线）
- [ ] 拖动选区框 → 流畅
- [ ] 调整 padding → 选区自动重算

### Photopea 测试
- [ ] 打开 Photopea → 图像加载
- [ ] 编辑后保存 → 图像同步
- [ ] 导出蒙版 → 验证可行性

---

## 10. 问题反馈

遇到问题？

1. **技术细节** → 查看 `docs/HANDOFF.md`（完整文档）
2. **实现方案** → 查看 `docs/implementation-plan.md`（详细代码）
3. **Photopea 问题** → 查看 `docs/technical-validation.md`（验证清单）
4. **历史记录** → 查看 `DEVLOG.md`（开发日志）

---

*创建时间：2026-03-02*  
*5 分钟快速了解，详细文档见 `docs/HANDOFF.md`*
