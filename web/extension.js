/**
 * InpaintRegionEditor Extension
 * 
 * 完全自己控制图像渲染，不依赖 ComfyUI 的图像预览
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ==================== Photopea Bridge ====================

const PhotopeaBridge = {
    iframe: null,
    photopeaWindow: null,
    PHOTOPEA_ORIGIN: "https://www.photopea.com",

    init(iframe) {
        this.iframe = iframe;
        this.photopeaWindow = iframe.contentWindow;
    },

    postMessage(message) {
        const self = this;
        return new Promise(function(resolve, reject) {
            if (!self.photopeaWindow) { reject(new Error("not init")); return; }
            const responses = [];
            const timeoutId = setTimeout(function() { reject(new Error("timeout")); }, 60000);
            const handler = function(event) {
                if (event.origin !== self.PHOTOPEA_ORIGIN) return;
                responses.push(event.data);
                if (event.data === "done") {
                    clearTimeout(timeoutId);
                    window.removeEventListener("message", handler);
                    resolve(responses);
                }
            };
            window.addEventListener("message", handler);
            self.photopeaWindow.postMessage(message, "*");
        });
    },

    async openImage(blob) {
        const self = this;
        return new Promise(function(resolve, reject) {
            const reader = new FileReader();
            reader.onloadend = async function() {
                try { await self.postMessage('app.open("' + reader.result + '", null, false);'); resolve(); }
                catch (e) { reject(e); }
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    },

    async exportImage(format) {
        const result = await this.postMessage('app.activeDocument.saveToOE("' + format + '");');
        for (let i = 0; i < result.length; i++) {
            if (result[i] instanceof ArrayBuffer) return new Blob([result[i]], { type: "image/" + format });
        }
        throw new Error("No image data");
    }
};

// ==================== Photopea Modal ====================

let ppState = { modal: null, node: null, path: null, open: false };

function showPhotopeaModal(node, imagePath) {
    ppState = { modal: null, node, path: imagePath, open: true };
    if (!document.getElementById("pp-style")) {
        const style = document.createElement("style");
        style.id = "pp-style";
        style.textContent = `.pp-modal{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.9);z-index:99999;display:flex;align-items:center;justify-content:center}.pp-container{width:95%;height:95%;display:flex;flex-direction:column;background:#1e1e1e;border-radius:8px;overflow:hidden}#pp-iframe{flex:1;width:100%;border:none}.pp-toolbar{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:#2d2d2d;border-top:1px solid #444}.pp-hint{color:#999;font-size:13px}.pp-btn{padding:10px 18px;border:none;border-radius:6px;cursor:pointer;font-size:14px;margin-left:10px}.pp-save{background:#107c10;color:#fff}.pp-cancel{background:#555;color:#fff}.pp-status{padding:8px 16px;background:#1a1a1a;color:#888;font-size:12px}`;
        document.head.appendChild(style);
    }
    ppState.modal = document.createElement("div");
    ppState.modal.className = "pp-modal";
    ppState.modal.innerHTML = `<div class="pp-container"><iframe id="pp-iframe" src="https://www.photopea.com/"></iframe><div class="pp-toolbar"><span class="pp-hint">编辑后点击保存</span><div><button id="pp-save" class="pp-btn pp-save">保存</button><button id="pp-cancel" class="pp-btn pp-cancel">取消</button></div></div><div class="pp-status" id="pp-status">加载中...</div></div>`;
    document.body.appendChild(ppState.modal);
    document.getElementById("pp-save").onclick = saveImg;
    document.getElementById("pp-cancel").onclick = closePhotopeaModal;
    document.getElementById("pp-iframe").onload = function() { if (ppState.open) { PhotopeaBridge.init(this); loadImg(); } };
}

function setStatus(t) { const el = document.getElementById("pp-status"); if (el) el.textContent = t; }

async function loadImg() {
    try {
        let filename = ppState.path, type = "input", subfolder = "";
        const m = ppState.path.match(/^(.+?)\s*\[(\w+)\]$/);
        if (m) { filename = m[1].trim(); type = m[2]; }
        const idx = filename.lastIndexOf("/");
        if (idx !== -1) { subfolder = filename.substring(0, idx); filename = filename.substring(idx + 1); }
        let url = "/view?filename=" + encodeURIComponent(filename) + "&type=" + encodeURIComponent(type);
        if (subfolder) url += "&subfolder=" + encodeURIComponent(subfolder);
        const resp = await fetch(url);
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        await PhotopeaBridge.openImage(await resp.blob());
        setStatus("已加载");
    } catch (e) { setStatus("错误: " + e.message); }
}

async function saveImg() {
    if (!ppState.open) return;
    try {
        setStatus("导出中...");
        const blob = await PhotopeaBridge.exportImage("png");
        setStatus("上传中...");
        const fd = new FormData();
        fd.append("image", blob, "edited_" + Date.now() + ".png");
        fd.append("type", "input");
        const resp = await api.fetchApi("/upload/image", { method: "POST", body: fd });
        const result = await resp.json();
        if (result.name) {
            const w = ppState.node.widgets?.find(x => x.name === "image");
            if (w) { w.value = result.name; if (w.callback) w.callback(result.name); }
            ppState.node.setDirtyCanvas(true);
            setStatus("已保存");
            setTimeout(closePhotopeaModal, 500);
        }
    } catch (e) { setStatus("错误: " + e.message); }
}

function closePhotopeaModal() {
    ppState.open = false;
    if (ppState.modal) { ppState.modal.remove(); ppState.modal = null; }
    ppState.node = null; ppState.path = null;
}

// ==================== 图像和选区数据 ====================

const nodeImageData = new Map();  // 存储每个节点的图像和选区数据

// 约束选区：框住蒙版且不超出图像边界
function constrainRegion(data, padding) {
    if (!data.hasMask || !data.maskBounds) return;
    
    const mask = data.maskBounds;
    
    // 计算期望的选区大小
    let regionWidth = mask.width + padding * 2;
    let regionHeight = mask.height + padding * 2;
    
    // 约束1：选区不能超过图像大小（自动缩小）
    regionWidth = Math.min(regionWidth, data.imageWidth);
    regionHeight = Math.min(regionHeight, data.imageHeight);
    
    // 计算选区位置（优先框住蒙版，然后约束不超出边界）
    let regionX = mask.x - padding;
    let regionY = mask.y - padding;
    
    // 约束2：选区不能超出图像边界
    // 左边界
    if (regionX < 0) regionX = 0;
    // 右边界
    if (regionX + regionWidth > data.imageWidth) {
        regionX = data.imageWidth - regionWidth;
    }
    // 上边界
    if (regionY < 0) regionY = 0;
    // 下边界
    if (regionY + regionHeight > data.imageHeight) {
        regionY = data.imageHeight - regionHeight;
    }
    
    // 更新数据
    data.regionX = regionX;
    data.regionY = regionY;
    data.regionWidth = regionWidth;
    data.regionHeight = regionHeight;
}

// 加载图像并检测蒙版
async function loadImageAndDetectMask(node, imageName) {
    if (!imageName) return;
    
    try {
        // 解析文件名
        let filename = imageName, type = "input", subfolder = "";
        const m = imageName.match(/^(.+?)\s*\[(\w+)\]$/);
        if (m) { filename = m[1].trim(); type = m[2]; }
        const idx = filename.lastIndexOf("/");
        if (idx !== -1) { subfolder = filename.substring(0, idx); filename = filename.substring(idx + 1); }
        
        // 获取图像
        let url = "/view?filename=" + encodeURIComponent(filename) + "&type=" + encodeURIComponent(type);
        if (subfolder) url += "&subfolder=" + encodeURIComponent(subfolder);
        
        const resp = await fetch(url);
        if (!resp.ok) return;
        const blob = await resp.blob();
        
        // 创建图像对象
        const img = new Image();
        img.onload = function() {
            // 检测蒙版
            const canvas = document.createElement("canvas");
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0);
            const imageData = ctx.getImageData(0, 0, img.width, img.height);
            const pixels = imageData.data;
            
            // 找蒙版边界
            let hasMask = false;
            let minX = img.width, minY = img.height, maxX = 0, maxY = 0;
            
            for (let y = 0; y < img.height; y++) {
                for (let x = 0; x < img.width; x++) {
                    const i = (y * img.width + x) * 4;
                    const alpha = pixels[i + 3];
                    if (alpha < 255) {
                        hasMask = true;
                        if (alpha < 128) {
                            minX = Math.min(minX, x);
                            minY = Math.min(minY, y);
                            maxX = Math.max(maxX, x);
                            maxY = Math.max(maxY, y);
                        }
                    }
                }
            }
            
            const padding = node.widgets?.find(w => w.name === "padding")?.value ?? 64;
            
            // 存储数据（包含原始URL供 MaskEditor 使用）
            const data = {
                image: img,
                imageUrl: url,  // 保存原始 ComfyUI URL
                imageName: filename,
                imageWidth: img.width,
                imageHeight: img.height,
                hasMask: hasMask
            };
            
            if (hasMask && minX <= maxX && minY <= maxY) {
                data.maskBounds = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
                // 使用统一的约束函数计算选区
                constrainRegion(data, padding);
            }
            
            nodeImageData.set(node.id, data);
            node.setDirtyCanvas(true);
        };
        img.src = URL.createObjectURL(blob);
    } catch (e) {
        console.error("Load image error:", e);
    }
}

// ==================== 绘制 ====================

function drawNode(ctx, node) {
    const data = nodeImageData.get(node.id);
    
    // 如果没有加载图像，就不画
    if (!data || !data.image || !data.image.complete) return;
    
    const img = data.image;
    
    // 计算 widgets 占用的高度
    let widgetsHeight = 0;
    if (node.widgets) {
        for (let i = node.widgets.length - 1; i >= 0; i--) {
            if (node.widgets[i].last_y !== undefined) {
                widgetsHeight = node.widgets[i].last_y + 25;
                break;
            }
        }
    }
    
    // 图像绘制区域
    const margin = 5;
    const imgAreaY = widgetsHeight + margin;
    const imgAreaW = node.size[0] - margin * 2;
    const imgAreaH = node.size[1] - imgAreaY - margin;
    
    if (imgAreaW <= 0 || imgAreaH <= 0) return;
    
    // 计算缩放（适应区域）
    const scale = Math.min(imgAreaW / img.naturalWidth, imgAreaH / img.naturalHeight);
    const imgW = img.naturalWidth * scale;
    const imgH = img.naturalHeight * scale;
    
    // 居中
    const imgX = margin + (imgAreaW - imgW) / 2;
    const imgY = imgAreaY + (imgAreaH - imgH) / 2;
    
    // 画图像
    ctx.drawImage(img, imgX, imgY, imgW, imgH);
    
    // 显示原图尺寸（在图像左下角内部）
    const sizeText = img.naturalWidth + "×" + img.naturalHeight;
    ctx.font = "10px sans-serif";
    const textWidth = ctx.measureText(sizeText).width;
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.fillRect(imgX, imgY + imgH - 14, textWidth + 6, 14);
    ctx.fillStyle = "#fff";
    ctx.fillText(sizeText, imgX + 3, imgY + imgH - 4);
    
    // 画选区框（如果有蒙版）
    if (data.hasMask && data.maskBounds) {
        // 橙色选区框
        const rx = imgX + data.regionX * scale;
        const ry = imgY + data.regionY * scale;
        const rw = data.regionWidth * scale;
        const rh = data.regionHeight * scale;
        
        ctx.fillStyle = "rgba(255, 165, 0, 0.2)";
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = "rgb(255, 165, 0)";
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.setLineDash([]);
        
        // 参考区标签
        ctx.font = "8px sans-serif";
        ctx.fillStyle = "rgba(255, 165, 0, 0.9)";
        ctx.fillRect(rx + 2, ry + 2, 55, 10);
        ctx.fillStyle = "#000";
        ctx.fillText("参考区 " + Math.round(data.regionWidth) + "×" + Math.round(data.regionHeight), rx + 3, ry + 9);
    }
}

// ==================== 拖动和调整大小 ====================

let dragging = null;
const EDGE_THRESHOLD = 8;  // 边缘检测阈值（屏幕像素）

// 检测鼠标在选区的哪个区域
function getResizeHandle(imgX, imgY, data, scale) {
    const rx = data.regionX;
    const ry = data.regionY;
    const rw = data.regionWidth;
    const rh = data.regionHeight;
    
    // 边缘检测阈值，不超过选区尺寸的 15%
    const baseThreshold = EDGE_THRESHOLD / scale;
    const thresholdX = Math.min(baseThreshold, rw * 0.15);
    const thresholdY = Math.min(baseThreshold, rh * 0.15);
    
    // 在选区内部
    const insideX = imgX >= rx && imgX <= rx + rw;
    const insideY = imgY >= ry && imgY <= ry + rh;
    
    if (!insideX || !insideY) return null;
    
    // 检测是否在边缘
    const nearLeft = imgX - rx < thresholdX;
    const nearRight = (rx + rw) - imgX < thresholdX;
    const nearTop = imgY - ry < thresholdY;
    const nearBottom = (ry + rh) - imgY < thresholdY;
    
    // 角落优先
    if (nearLeft && nearTop) return 'tl';
    if (nearRight && nearTop) return 'tr';
    if (nearLeft && nearBottom) return 'bl';
    if (nearRight && nearBottom) return 'br';
    
    // 边缘
    if (nearLeft) return 'l';
    if (nearRight) return 'r';
    if (nearTop) return 't';
    if (nearBottom) return 'b';
    
    // 中间
    return 'move';
}

function getImageDrawParams(node) {
    const data = nodeImageData.get(node.id);
    if (!data || !data.image || !data.image.complete) return null;
    
    const img = data.image;
    
    let widgetsHeight = 0;
    if (node.widgets) {
        for (let i = node.widgets.length - 1; i >= 0; i--) {
            if (node.widgets[i].last_y !== undefined) {
                widgetsHeight = node.widgets[i].last_y + 25;
                break;
            }
        }
    }
    
    const margin = 5;
    const imgAreaY = widgetsHeight + margin;
    const imgAreaW = node.size[0] - margin * 2;
    const imgAreaH = node.size[1] - imgAreaY - margin;
    
    if (imgAreaW <= 0 || imgAreaH <= 0) return null;
    
    const scale = Math.min(imgAreaW / img.naturalWidth, imgAreaH / img.naturalHeight);
    const imgW = img.naturalWidth * scale;
    const imgH = img.naturalHeight * scale;
    const imgX = margin + (imgAreaW - imgW) / 2;
    const imgY = imgAreaY + (imgAreaH - imgH) / 2;
    
    return { imgX, imgY, scale };
}

function onMouseDown(node, pos, e) {
    const data = nodeImageData.get(node.id);
    if (!data || !data.hasMask) return false;
    
    const params = getImageDrawParams(node);
    if (!params) return false;
    
    // pos 已经是节点本地坐标
    const localX = pos[0];
    const localY = pos[1];
    
    // 转图像坐标
    const imgX = (localX - params.imgX) / params.scale;
    const imgY = (localY - params.imgY) / params.scale;
    
    // 检测点击位置
    const handle = getResizeHandle(imgX, imgY, data, params.scale);
    
    if (handle) {
        dragging = {
            node: node,
            handle: handle,
            startImgX: imgX,
            startImgY: imgY,
            origRegionX: data.regionX,
            origRegionY: data.regionY,
            origRegionWidth: data.regionWidth,
            origRegionHeight: data.regionHeight
        };
        // 拖动时改变光标
        requestAnimationFrame(() => {
            const canvasEl = app.canvas.canvas;
            if (canvasEl) {
                canvasEl.style.cursor = handle === 'move' ? 'grabbing' : 
                    ({'tl': 'nwse-resize', 'tr': 'nesw-resize', 'bl': 'nesw-resize', 'br': 'nwse-resize',
                      'l': 'ew-resize', 'r': 'ew-resize', 't': 'ns-resize', 'b': 'ns-resize'}[handle] || 'crosshair');
            }
        });
        return true;  // 消费事件，阻止节点拖动
    }
    
    return false;
}

function onMouseMove(e, pos, node) {
    const data = nodeImageData.get(node.id);
    if (!data || !data.hasMask) return;
    
    const params = getImageDrawParams(node);
    if (!params) return;
    
    // 转图像坐标
    const localX = pos[0];
    const localY = pos[1];
    const imgX = (localX - params.imgX) / params.scale;
    const imgY = (localY - params.imgY) / params.scale;
    
    // 检测手柄
    const handle = getResizeHandle(imgX, imgY, data, params.scale);
    
    // 如果正在拖动
    if (dragging) {
        // 计算偏移
        const dx = imgX - dragging.startImgX;
        const dy = imgY - dragging.startImgY;
        
        const mask = data.maskBounds;
        
        if (dragging.handle === 'move') {
            // 拖动位置
            let newRegionX = dragging.origRegionX + dx;
            let newRegionY = dragging.origRegionY + dy;
            
            const mask = data.maskBounds;
            
            // 约束1：选区必须框住蒙版
            // 选区左边 <= 蒙版左边，选区右边 >= 蒙版右边
            const maskRight = mask.x + mask.width;
            const maskBottom = mask.y + mask.height;
            
            let minX = maskRight - data.regionWidth;  // 选区右边 >= 蒙版右边
            let maxX = mask.x;                         // 选区左边 <= 蒙版左边
            
            let minY = maskBottom - data.regionHeight;
            let maxY = mask.y;
            
            // 约束2：选区不能超出图像边界
            minX = Math.max(0, minX);
            maxX = Math.min(maxX, data.imageWidth - data.regionWidth);
            minY = Math.max(0, minY);
            maxY = Math.min(maxY, data.imageHeight - data.regionHeight);
            
            data.regionX = Math.max(minX, Math.min(maxX, newRegionX));
            data.regionY = Math.max(minY, Math.min(maxY, newRegionY));
            
        } else {
            // 调整大小
            let newWidth = dragging.origRegionWidth;
            let newHeight = dragging.origRegionHeight;
            let newX = dragging.origRegionX;
            let newY = dragging.origRegionY;
            
            const handle = dragging.handle;
            
            // 根据手柄类型调整
            if (handle.includes('r')) {
                // 右边
                newWidth = dragging.origRegionWidth + dx;
            }
            if (handle.includes('l')) {
                // 左边
                newWidth = dragging.origRegionWidth - dx;
                newX = dragging.origRegionX + dx;
            }
            if (handle.includes('b')) {
                // 下边
                newHeight = dragging.origRegionHeight + dy;
            }
            if (handle.includes('t')) {
                // 上边
                newHeight = dragging.origRegionHeight - dy;
                newY = dragging.origRegionY + dy;
            }
            
            // 约束1：最小尺寸 = 蒙版边界框
            const minW = mask.width;
            const minH = mask.height;
            newWidth = Math.max(minW, newWidth);
            newHeight = Math.max(minH, newHeight);
            
            // 约束2：最大尺寸 = 图像边界
            newWidth = Math.min(newWidth, data.imageWidth);
            newHeight = Math.min(newHeight, data.imageHeight);
            
            // 约束3：位置不能超出边界
            if (newX < 0) {
                newWidth += newX;  // 减小宽度
                newX = 0;
            }
            if (newY < 0) {
                newHeight += newY;
                newY = 0;
            }
            if (newX + newWidth > data.imageWidth) {
                newWidth = data.imageWidth - newX;
            }
            if (newY + newHeight > data.imageHeight) {
                newHeight = data.imageHeight - newY;
            }
            
            // 约束4：选区必须框住蒙版
            const maskRight = mask.x + mask.width;
            const maskBottom = mask.y + mask.height;
            
            // 如果左边 > 蒙版左边，调整
            if (newX > mask.x) {
                const diff = newX - mask.x;
                newX = mask.x;
                newWidth += diff;
            }
            // 如果右边 < 蒙版右边，调整
            if (newX + newWidth < maskRight) {
                newWidth = maskRight - newX;
            }
            // 如果上边 > 蒙版上边，调整
            if (newY > mask.y) {
                const diff = newY - mask.y;
                newY = mask.y;
                newHeight += diff;
            }
            // 如果下边 < 蒙版下边，调整
            if (newY + newHeight < maskBottom) {
                newHeight = maskBottom - newY;
            }
            
            // 再次检查边界
            if (newX < 0) { newX = 0; }
            if (newY < 0) { newY = 0; }
            if (newX + newWidth > data.imageWidth) { newWidth = data.imageWidth - newX; }
            if (newY + newHeight > data.imageHeight) { newHeight = data.imageHeight - newY; }
            
            data.regionX = newX;
            data.regionY = newY;
            data.regionWidth = newWidth;
            data.regionHeight = newHeight;
        }
        
        // 同步到 widget
        const coordsWidget = dragging.node.widgets?.find(w => w.name === "region_coords");
        if (coordsWidget) {
            coordsWidget.value = JSON.stringify({
                x: Math.round(data.regionX),
                y: Math.round(data.regionY),
                width: Math.round(data.regionWidth),
                height: Math.round(data.regionHeight)
            });
        }
        
        dragging.node.setDirtyCanvas(true);
    } else {
        // 非拖动状态：检测光标位置
        const handle = getResizeHandle(imgX, imgY, data, params.scale);
        
        if (handle) {
            // 根据手柄类型设置光标
            const cursorMap = {
                'move': 'grab',
                'tl': 'nwse-resize',
                'tr': 'nesw-resize',
                'bl': 'nesw-resize',
                'br': 'nwse-resize',
                'l': 'ew-resize',
                'r': 'ew-resize',
                't': 'ns-resize',
                'b': 'ns-resize'
            };
            // 延迟设置，确保在原生代码之后执行
            const cursor = cursorMap[handle] || 'crosshair';
            requestAnimationFrame(() => {
                const canvasEl = app.canvas.canvas;
                if (canvasEl) {
                    canvasEl.style.cursor = cursor;
                }
            });
        } else {
            const canvasEl = app.canvas.canvas;
            if (canvasEl) {
                canvasEl.style.cursor = 'crosshair';
            }
        }
    }
}

function onMouseUp() {
    dragging = null;
    requestAnimationFrame(() => {
        const canvasEl = app.canvas.canvas;
        if (canvasEl) {
            canvasEl.style.cursor = 'crosshair';
        }
    });
}

// ==================== 注册扩展 ====================

app.registerExtension({
    name: "InpaintRegionEditor",
    
    init() {
        // 全局粘贴事件监听（捕获阶段，优先于系统处理）
        document.addEventListener("paste", async (e) => {
            // 检查是否有选中的节点
            const selectedNodes = app.canvas.selected_nodes;
            if (!selectedNodes || Object.keys(selectedNodes).length !== 1) return;
            
            const node = Object.values(selectedNodes)[0];
            // 只处理我们的节点
            if (node.type !== "InpaintRegionEditor") return;
            
            // 检查剪贴板是否有图片
            const items = e.clipboardData?.items;
            if (!items) return;
            
            for (const item of items) {
                if (item.type.startsWith("image/")) {
                    // 阻止系统处理
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    
                    const file = item.getAsFile();
                    if (!file) continue;
                    
                    try {
                        // 上传图片
                        const fd = new FormData();
                        fd.append("image", file, file.name || "pasted.png");
                        fd.append("type", "input");
                        
                        const resp = await api.fetchApi("/upload/image", { method: "POST", body: fd });
                        const result = await resp.json();
                        
                        if (result.name) {
                            // 更新 widget
                            const imgW = node.widgets?.find(w => w.name === "image");
                            if (imgW) {
                                imgW.value = result.name;
                                if (imgW.callback) imgW.callback(result.name);
                            }
                            node.setDirtyCanvas(true);
                        }
                    } catch (err) {
                        console.error("Paste image error:", err);
                    }
                    break;
                }
            }
        }, true);  // 捕获阶段
    },
    
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "InpaintRegionEditor") return;
        
        // 右键菜单
        const origGetMenu = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function(canvas, options) {
            if (origGetMenu) origGetMenu.apply(this, arguments);
            const hasPp = options.some(o => o && o.content && o.content.includes("Photopea"));
            if (hasPp) return;
            const node = this;
            const imgW = node.widgets?.find(w => w.name === "image");
            options.push(null);
            options.push({
                content: "打开 Photopea 编辑",
                callback: function() { imgW?.value ? showPhotopeaModal(node, imgW.value) : alert("请先选择图像"); }
            });
            // Open in MaskEditor - 使用正确的命令调用
            options.push({
                content: "Open in MaskEditor",
                callback: function() {
                    if (!imgW?.value) { alert("请先选择图像"); return; }
                    const data = nodeImageData.get(node.id);
                    if (!data?.imageUrl) { alert("图像尚未加载完成"); return; }
                    
                    // 创建带有正确 URL 的图像对象供 MaskEditor 使用
                    const maskEditorImg = new Image();
                    maskEditorImg.src = data.imageUrl;
                    node.imgs = [maskEditorImg];
                    
                    // 选中节点并执行命令
                    app.canvas.selectNode(node);
                    app.extensionManager.command.execute("Comfy.MaskEditor.OpenMaskEditor");
                }
            });
        };
        
        // 自己绘制图像和选区框
        const origDrawBg = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function(ctx) {
            const node = this;
            
            // 检查是否有 MaskEditor 设置的 imgs（用户刚编辑完）
            if (node.imgs && node.imgs.length > 0) {
                const ourData = nodeImageData.get(node.id);
                // 如果我们有数据，说明 MaskEditor 刚关闭，需要重新加载
                if (ourData && ourData.imageUrl) {
                    const imgW = node.widgets?.find(w => w.name === "image");
                    if (imgW?.value) {
                        // 异步重新加载，避免阻塞渲染
                        setTimeout(() => loadImageAndDetectMask(node, imgW.value), 0);
                    }
                }
                // 用空数组替换，防止系统渲染（但不能用 null，会崩溃）
                node.imgs = [];
            }
            
            if (origDrawBg) origDrawBg.apply(this, arguments);
            drawNode(ctx, this);
        };
        
        // 节点创建
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            if (onNodeCreated) onNodeCreated.apply(this, arguments);
            
            const node = this;
            
            // 监听图像变化
            const imgW = node.widgets?.find(w => w.name === "image");
            if (imgW) {
                const origCb = imgW.callback;
                imgW.callback = function(v) {
                    if (origCb) origCb.apply(this, arguments);
                    loadImageAndDetectMask(node, v);
                };
            }
            
            // 监听 padding 变化
            const padW = node.widgets?.find(w => w.name === "padding");
            if (padW) {
                const origCb = padW.callback;
                padW.callback = function(v) {
                    if (origCb) origCb.apply(this, arguments);
                    const data = nodeImageData.get(node.id);
                    if (data && data.hasMask && data.maskBounds) {
                        // 使用统一的约束函数重新计算选区
                        constrainRegion(data, v);
                    }
                    node.setDirtyCanvas(true);
                };
            }
        };
        
        // 鼠标事件
        const origMouseDown = nodeType.prototype.onMouseDown;
        nodeType.prototype.onMouseDown = function(e, pos, canvas) {
            if (onMouseDown(this, pos, e)) {
                return true;  // 阻止节点拖动
            }
            return origMouseDown ? origMouseDown.apply(this, arguments) : false;
        };
        
        // 鼠标移动
        const origMouseMove = nodeType.prototype.onMouseMove;
        nodeType.prototype.onMouseMove = function(e, pos, canvas) {
            onMouseMove(e, pos, this);
            return origMouseMove ? origMouseMove.apply(this, arguments) : false;
        };
        
        // 鼠标释放
        const origMouseUp = nodeType.prototype.onMouseUp;
        nodeType.prototype.onMouseUp = function(e, pos, canvas) {
            onMouseUp();
            return origMouseUp ? origMouseUp.apply(this, arguments) : false;
        };
    }
});
