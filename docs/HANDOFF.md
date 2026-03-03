# InpaintRegionEditor 项目交接文档

> 版本：1.4 | 日期：2026-03-03
> 交接对象：开发团队
> 交接人：项目经理 Agent

---

## 一、项目概述

### 1.1 项目定位

**InpaintRegionEditor** 是一个 ComfyUI 自定义节点，用于解决局部重绘（inpaint）工作流中的两个核心问题：

1. **图像编辑**：ComfyUI 自身没有图像编辑功能，需要集成 Photopea 实现液化、仿制图章等 PS 级功能
2. **蒙版编辑**：支持羽化效果的蒙版编辑，使用 Photopea 双图层模式
3. **选区调整**：原有的扩散选区功能无法手动调整位置，导致边缘参考区域错误

### 1.2 核心价值

```
原工作流痛点：
├─ 蒙版编辑：ComfyUI 自带工具功能有限，无法处理复杂蒙版（羽化、透明度等）
├─ 图像编辑：完全没有，需要外部 PS 处理后再上传
└─ 选区调整：只能中心扩散，无法手动移动位置

本节点解决方案：
├─ 集成 Photopea：完整的 Photoshop 功能，浏览器内完成编辑
├─ 双模式编辑：编辑图像 / 编辑蒙版（分离操作）
├─ 羽化支持：半透明蒙版自动转换为羽化效果
├─ 可拖动选区：手动调整参考区域位置，确保参考内容准确
└─ 一体化流程：上传 → 编辑 → 选区调整 → 执行，无需切换工具
```

### 1.3 节点功能

```
输入：
  - image: 从 ComfyUI input 目录选择（支持上传、Ctrl+V 粘贴）
  - padding: 扩散像素数（默认 64，范围 0-512）

自动处理：
  1. 读取图像 Alpha 通道作为 MASK
  2. 没有 Alpha → 报错 "请先创建蒙版"
  3. 有 Alpha → 计算蒙版边界框（alpha < 255 都计入）
  4. 选区 = 蒙版边界 + padding
  5. 在图像预览上绘制遮罩 + 选区框（可拖动、可调整大小）

用户操作：
  - 右键 → "编辑图像（Photopea）"：编辑图像本身
  - 右键 → "编辑蒙版（Photopea）"：双图层蒙版编辑（参考图像 + 蒙版层）
  - 右键 → "Open in MaskEditor"：使用 ComfyUI 自带蒙版编辑器
  - 拖动选区框：手动调整参考区域位置
  - 调整选区边缘：拖动边缘/角落调整选区大小
  - 调整 padding 值：改变扩散像素数
  - Ctrl+V：粘贴图片

输出：
  - IMAGE: RGB 图像（不含 Alpha）
  - MASK: 从 Alpha 通道提取
  - region_top, region_left, region_width, region_height: 选区坐标
```

---

## 二、核心需求确认

### 2.1 蒙版来源（三种）

1. **用户上传**：带 Alpha 通道的 PNG 文件
2. **Photopea 编辑**：在 Photopea 里绘制蒙版后保存
3. **系统工具**：使用 ComfyUI 自带蒙版工具绘制后保存

### 2.2 核心逻辑

```python
if 没有蒙版（Alpha 通道）:
    执行时报错："请先创建蒙版（局部重绘需要蒙版）"
else:
    自动计算选区 = 蒙版边界 + padding
    在预览上绘制遮罩（半透明红）+ 选区框（橙色虚线）
    用户可以拖动选区框位置
    输出 region_* 坐标
```

### 2.3 选区概念

| 概念 | 定义 | 作用 |
|------|------|------|
| **遮罩 (Mask)** | 需要重绘的区域（可能是不规则形状） | AI 在这个区域内生成新内容 |
| **选区 (Region)** | 参考区域（矩形框） | AI 参考这个区域内的原图内容进行重绘 |

**约束**：选区必须 >= 遮罩（选区要完全包含遮罩）

**选区计算逻辑**：
```
选区边界 = 遮罩边界框 + padding（向四周扩散）
用户可拖动选区位置，但选区必须始终框住遮罩
```

---

## 三、技术架构

### 3.1 文件结构

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
│   └── style.css               # 样式
│
└── docs/
    ├── technical-validation.md # 技术验证清单
    ├── implementation-plan.md  # 详细实现方案
    └── HANDOFF.md              # 本文档
```

### 3.2 整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ComfyUI 前端                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  InpaintRegionEditor 节点                                      │ │
│  │                                                               │ │
│  │  ┌───────────────────────────────────────────────────────┐   │ │
│  │  │  图像预览区域                                          │   │ │
│  │  │  ┌───────────────────────────────────────────────┐    │   │ │
│  │  │  │  [图像]                                        │    │   │ │
│  │  │  │  ┌──────────────┐                             │    │   │ │
│  │  │  │  │ ████████████ │ ← 遮罩（半透明红）            │    │   │ │
│  │  │  │  │ │          │ │                             │    │   │ │
│  │  │  │  │ │  虚线框   │ │ ← 选区（橙色虚线，可拖动）   │    │   │ │
│  │  │  │  │ │          │ │                             │    │   │ │
│  │  │  │  │ ████████████ │                             │    │   │ │
│  │  │  │  └──────────────┘                             │    │   │ │
│  │  │  └───────────────────────────────────────────────┘    │   │ │
│  │  │                                                        │   │ │
│  │  │  控件：                                                │   │ │
│  │  │  - 图像：[image.png ▼] [上传]                         │   │ │
│  │  │  - 扩散像素：[64] ▼                                   │   │ │
│  │  │  - [🎨 打开 Photopea 编辑]                             │   │ │
│  │  └───────────────────────────────────────────────────────┘   │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                          ↕                                          │
│              隐藏 widget: region_coords (JSON)                     │
│                          ↕                                          │
└─────────────────────────────────────────────────────────────────────┘
                          ↕
┌─────────────────────────────────────────────────────────────────────┐
│                       ComfyUI 后端                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  nodes.py: InpaintRegionEditor.process()                           │
│  1. 加载图像（从 input 目录）                                        │
│  2. 提取 Alpha 通道 → MASK                                          │
│  3. 计算遮罩边界框                                                   │
│  4. 计算选区 = 遮罩边界 + padding                                   │
│  5. 验证：选区 >= 遮罩                                              │
│  6. 输出：IMAGE, MASK, region_*                                     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                          ↕
┌─────────────────────────────────────────────────────────────────────┐
│                        Photopea                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  - 通过 iframe 嵌入（全屏模态框）                                    │
│  - postMessage API 通信                                             │
│  - 功能：图像编辑 + 蒙版绘制                                        │
│  - 导出：PNG 图像 + 黑白蒙版图                                       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.3 数据流

```
1. 用户上传图像
   └─▶ POST /upload/image → input/image.png

2. 节点加载图像
   └─▶ 读取 Alpha 通道 → MASK
   └─▶ 计算遮罩边界 → 选区
   └─▶ 前端绘制：遮罩 + 选区框

3. 用户编辑（可选）
   └─▶ 右键 → 打开 Photopea
   └─▶ 编辑图像/蒙版
   └─▶ 保存 → 上传新文件
   └─▶ 更新节点 widget.value

4. 用户调整选区（可选）
   └─▶ 拖动选区框
   └─▶ 更新 region_coords (hidden widget)

5. 执行工作流
   └─▶ 后端读取图像 + region_coords
   └─▶ 输出：IMAGE, MASK, region_*
```

---

## 四、关键技术点

### 4.1 蒙版处理

**提取逻辑**（nodes.py）：
```python
if 'A' in img.getbands():
    mask = np.array(img.getchannel('A')).astype(np.float32) / 255.0
    mask = 1.0 - mask  # ComfyUI 约定：1=遮罩区域，0=背景
else:
    raise ValueError("请先创建蒙版")
```

**格式约定**：
- PNG Alpha = 0（透明） → mask = 1.0（遮罩区域）
- PNG Alpha = 255（不透明） → mask = 0.0（背景）

### 4.2 选区计算

```python
def _calculate_region_rect(mask_bounds, padding):
    """根据遮罩边界 + padding 计算选区"""
    return {
        'x': mask_bounds['x'] - padding,
        'y': mask_bounds['y'] - padding,
        'width': mask_bounds['width'] + padding * 2,
        'height': mask_bounds['height'] + padding * 2
    }
```

**约束验证**：
```python
if (region_rect['width'] < mask_bounds['width'] or 
    region_rect['height'] < mask_bounds['height']):
    raise ValueError("选区必须 >= 遮罩")
```

### 4.3 Photopea 集成

**通信机制**：
```javascript
// 发送消息到 Photopea
photopeaWindow.postMessage('app.activeDocument.saveToOE("png");', "*");

// 接收响应（验证 origin）
window.addEventListener("message", (event) => {
    if (event.origin !== "https://www.photopea.com") return;
    // 处理响应...
});
```

**待验证功能**：
1. 能否单独导出蒙版？（`layer.mask` 已知返回 null）
2. 能否同时加载原图 + 蒙版？
3. 能否检测用户是否画了蒙版？

**参考 workaround**（DEVLOG 中提到）：
```javascript
// 虽然 layer.mask 返回 null，但这行代码可能工作
doc.activeChannel = layer.mask;
doc.selection.selectAll();
doc.selection.copy();
```

### 4.4 选区框绘制

**参考实现**：`ComfyUI-Impact-Pack/js/mask-rect-area.js`

**核心功能**：
- 自定义 Canvas Widget
- 绘制遮罩（半透明红）
- 绘制选区框（橙色虚线）
- 鼠标拖动交互
- 同步坐标到 widget

---

## 五、待验证技术点

### 5.1 高优先级（决定方案可行性）

| 编号 | 测试项 | 目的 | 状态 |
|------|-------|------|------|
| P1 | Photopea 同时加载原图 + 蒙版 | 确定工作流 | ❓ 待测试 |
| P2 | Photopea 单独导出蒙版 | 确定保存逻辑 | ❓ 待测试 |
| P3 | Photopea 检测是否有蒙版 | 确定错误提示 | ❓ 待测试 |

### 5.2 中优先级（影响用户体验）

| 编号 | 测试项 | 目的 | 状态 |
|------|-------|------|------|
| M1 | Canvas 选区框绘制 | 参考 Impact-Pack | ✅ 有参考代码 |
| M2 | 拖动交互实现 | 鼠标事件监听 | ✅ 有参考代码 |
| M3 | 坐标同步机制 | hidden widget | ✅ 已验证 |

### 5.3 低优先级（可迭代优化）

| 编号 | 测试项 | 目的 | 状态 |
|------|-------|------|------|
| L1 | 两次导出上传 | 图像 + 蒙版分开保存 | ❓ 待测试 |
| L2 | 后端合成 PNG | 两张图合成带 Alpha 的 PNG | ✅ 简单 |
| L3 | UI 样式优化 | 美观度提升 | - 后期 |

---

## 六、实现路线图

### Phase 1：后端基础（1 天）

**任务**：
- [ ] 更新 `nodes.py` 实现核心逻辑
- [ ] 测试蒙版提取（从 Alpha 通道）
- [ ] 测试选区计算（遮罩边界 + padding）
- [ ] 测试错误提示（没有蒙版时报错）

**交付物**：
- 可运行的后端节点
- 单元测试脚本

### Phase 2：选区 UI（2 天）

**任务**：
- [ ] 实现 `region-box-editor.js`
- [ ] 在节点上绘制遮罩预览
- [ ] 在节点上绘制选区框（虚线）
- [ ] 实现拖动交互
- [ ] 约束验证（选区 >= 遮罩）

**参考**：`ComfyUI-Impact-Pack/js/mask-rect-area.js`

**交付物**：
- 可在节点上显示并拖动选区框

### Phase 3：Photopea 集成（2-3 天）

**任务**：
- [ ] 实现 `photopea-modal.js`
- [ ] 实现 `photopea-bridge.js`
- [ ] 测试图像加载（`&channel=rgb` 参数）
- [ ] 测试图像导出
- [ ] **测试蒙版导出**（关键！）
- [ ] 上传回 ComfyUI

**交付物**：
- 可打开 Photopea 编辑
- 可保存回节点

### Phase 4：集成测试（1 天）

**任务**：
- [ ] 完整工作流测试
- [ ] 修复 bug
- [ ] 编写 README

**交付物**：
- 可发布的完整版本

---

## 七、已知风险与备选方案

### 7.1 Photopea API 限制

**问题**：`layer.mask` 总是返回 `null`（官方已知，Issue #7341）

**影响**：无法通过脚本访问图层蒙版

**备选方案**：
1. 用 workaround 尝试导出（`doc.activeChannel = layer.mask`）
2. 如果不行，用户只能用其他方式创建蒙版（系统工具/上传）
3. 或者在 Photopea 里手动合成到 Alpha 通道后导出

### 7.2 蒙版语义差异

**问题**：
- Photopea 蒙版：白色 = 显示（非遮罩），黑色 = 隐藏（遮罩）
- ComfyUI Mask：白色 = 遮罩区域，黑色 = 背景

**解决**：导出时反转

### 7.3 性能问题

**问题**：大图片（>2048x2048）可能导致 Photopea 卡顿

**解决**：
- 提示用户使用合适尺寸
- 可选：前端缩放后编辑

---

## 八、参考资源

### 8.1 代码参考

| 文件 | 位置 | 用途 |
|------|------|------|
| `mask-rect-area.js` | `E:\ComfyUI\custom_nodes\ComfyUI-Impact-Pack\js\` | 选区框绘制参考 |
| `nodes.py` (LoadImage) | `E:\ComfyUI\nodes.py` (line 1702) | 图像加载参考 |
| `server.py` | `E:\ComfyUI\server.py` | 上传 API 参考 |

### 8.2 文档参考

| 文档 | 说明 |
|------|------|
| [Photopea API](https://www.photopea.com/api/) | 官方 API 文档 |
| [technical-validation.md](./technical-validation.md) | 技术验证清单 |
| [implementation-plan.md](./implementation-plan.md) | 详细实现方案 |
| [DEVLOG.md](../DEVLOG.md) | 开发日志（包含历史问题记录） |

### 8.3 外部参考

| 项目 | 说明 |
|------|------|
| [sd-webui-photopea-embed](https://github.com/yankooliveira/sd-webui-photopea-embed) | Stable Diffusion WebUI 的 Photopea 集成 |
| [ComfyUI-Impact-Pack](https://github.com/ltdrdata/ComfyUI-Impact-Pack) | 选区框实现参考 |

---

## 九、团队协作建议

### 9.1 分工建议

**后端开发**（1 人）：
- `nodes.py` 实现
- 蒙版提取逻辑
- 选区计算逻辑

**前端开发**（1 人）：
- Canvas 选区框绘制
- 拖动交互实现
- Photopea 集成

**测试**（1 人）：
- Photopea 功能验证
- 完整工作流测试
- Bug 报告

### 9.2 沟通要点

1. **Photopea 验证结果** 决定技术路线
   - 如果能单独导出蒙版 → 方案 A
   - 如果不能 → 方案 B（用户手动合成到 Alpha）

2. **选区 UI 复杂度** 可能被低估
   - 建议先用 Impact-Pack 代码验证可行性
   - 再考虑自定义需求

3. **错误提示要友好**
   - 没有蒙版时告诉用户三种创建方式
   - 选区太小时提示最小尺寸

---

## 十、验收标准

### 10.1 功能验收

- [ ] 用户上传带 Alpha 的 PNG → 正确显示遮罩 + 选区
- [ ] 用户上传不带 Alpha 的 PNG → 执行时报错（友好提示）
- [ ] 拖动选区框 → 坐标实时更新
- [ ] 调整 padding → 选区自动重算
- [ ] 打开 Photopea → 可以编辑图像
- [ ] Photopea 保存 → 图像同步到节点
- [ ] 输出 region_* → 下游节点可用

### 10.2 性能验收

- [ ] 加载 1024x1024 图像 < 2 秒
- [ ] 拖动选区框流畅（60fps）
- [ ] Photopea 打开 < 5 秒（首次加载缓存后）

### 10.3 兼容性验收

- [ ] Windows / Linux / macOS
- [ ] Chrome / Firefox / Edge
- [ ] ComfyUI 最新版本

---

## 十一、联系与反馈

### 11.1 问题记录

开发过程中遇到的任何问题，请记录到：
- `docs/DEVLOG.md`（开发日志）
- GitHub Issues（如果有仓库）

### 11.2 关键决策记录

任何偏离本方案的技术决策，请记录：
- 决策内容
- 决策原因
- 决策日期

---

## 十二、附录

### 12.1 术语表

| 术语 | 定义 |
|------|------|
| **Mask（遮罩）** | 定义重绘区域，AI 在这个区域内生成新内容 |
| **Region（选区）** | 定义参考区域，AI 参考这个区域内的原图内容 |
| **Padding（扩散）** | 选区相对于遮罩边界的扩散像素数 |
| **Alpha 通道** | PNG 的透明度通道，用于存储蒙版 |
| **羽化** | 蒙版边缘的半透明过渡效果（alpha = 1-254） |

### 12.2 版本历史

| 版本 | 日期 | 说明 |
|------|------|------|
| 0.1 | 2026-02-27 | 初始版本（简化版，仅 Photopea 集成） |
| 1.0 | 2026-03-02 | 需求最终确认，编写 handoff 文档 |
| 1.1 | 2026-03-03 | Photopea 蒙版编辑功能，修复透明区域 RGB 数据丢失问题 |
| 1.2 | 2026-03-03 | 选区调整大小、光标变化、Ctrl+V 粘贴、MaskEditor 集成 |
| 1.3 | 2026-03-03 | MaskEditor clipspace 支持、选区坐标同步、羽化效果 |
| 1.4 | 2026-03-03 | 多语言支持（中英文）、修复编辑图像透明区域 RGB 数据丢失、修复选区坐标自动更新 |

---

## 十三、关键技术实现

### 13.1 Canvas Premultiplied Alpha 问题

**问题描述**：
当 Canvas 通过 `drawImage()` 绘制带有 Alpha < 255 的 PNG 图像时，浏览器会应用 **premultiplied alpha**，导致 Alpha = 0 的像素 RGB 数据丢失。

**解决方案**：
1. **加载时**：使用 ComfyUI `/view` API 的 `channel=rgb` 和 `channel=a` 参数分别获取 RGB 和 Alpha 数据
2. **保存时**：使用 UPNG.js 库直接编码 RGBA 数据，绑过 Canvas 的 premultiplied alpha

### 13.2 Photopea 蒙版编辑流程

```
1. 加载图像
   ├─ 获取 RGB 数据（channel=rgb）→ 完整 RGB，无窟窿
   └─ 获取 Alpha 数据（channel=a）→ 用于创建蒙版层

2. 创建双图层文档
   ├─ 底层：参考图像（完整 RGB）
   └─ 顶层：蒙版层（用户在此绘制黑色 = 遮罩）

3. 保存蒙版
   ├─ 隐藏参考图像层
   ├─ 只导出蒙版层
   ├─ 获取原图 RGB（channel=rgb）
   └─ 合并蒙版到 Alpha 通道（UPNG.js 编码）
```

### 13.3 羽化逻辑

```
蒙版层（用户绘制）：
- 黑色不透明（alpha=255）→ 遮罩 → 最终 alpha=0
- 黑色半透明（alpha=128）→ 羽化 → 最终 alpha=128
- 完全透明（alpha=0）→ 不遮罩 → 最终 alpha=255

公式：最终 alpha = 255 - 蒙版层alpha
```

---

*文档创建时间：2026-03-02*  
*最后更新时间：2026-03-03*  
*基于与用户的多次讨论整理*  
*交接完成标志：开发团队确认收到并理解本文档*
