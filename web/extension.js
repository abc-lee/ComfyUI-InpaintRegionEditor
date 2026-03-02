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

const nodeData = new Map();  // 存储每个节点的图像和选区数据

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
            
            // 存储数据
            const data = {
                image: img,
                imageWidth: img.width,
                imageHeight: img.height,
                hasMask: hasMask
            };
            
            if (hasMask && minX <= maxX && minY <= maxY) {
                data.maskBounds = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
                data.regionX = Math.max(0, minX - padding);
                data.regionY = Math.max(0, minY - padding);
                data.regionWidth = (maxX - minX + 1) + padding * 2;
                data.regionHeight = (maxY - minY + 1) + padding * 2;
            }
            
            nodeData.set(node.id, data);
            node.setDirtyCanvas(true);
        };
        img.src = URL.createObjectURL(blob);
    } catch (e) {
        console.error("Load image error:", e);
    }
}

// ==================== 绘制 ====================

function drawNode(ctx, node) {
    const data = nodeData.get(node.id);
    
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
        
        // 红色遮罩区域
        const mx = imgX + data.maskBounds.x * scale;
        const my = imgY + data.maskBounds.y * scale;
        const mw = data.maskBounds.width * scale;
        const mh = data.maskBounds.height * scale;
        
        ctx.fillStyle = "rgba(255, 0, 0, 0.4)";
        ctx.fillRect(mx, my, mw, mh);
        
        // 标签
        ctx.font = "11px sans-serif";
        
        ctx.fillStyle = "rgba(255, 165, 0, 0.9)";
        ctx.fillRect(rx + 2, ry + 2, 70, 14);
        ctx.fillStyle = "#000";
        ctx.fillText("选区 " + data.regionWidth + "×" + data.regionHeight, rx + 4, ry + 12);
        
        ctx.fillStyle = "rgba(255, 0, 0, 0.9)";
        ctx.fillRect(mx + 2, my + 2, 70, 14);
        ctx.fillStyle = "#fff";
        ctx.fillText("遮罩 " + data.maskBounds.width + "×" + data.maskBounds.height, mx + 4, my + 12);
    }
}

// ==================== 拖动 ====================

let dragging = null;

function getImageDrawParams(node) {
    const data = nodeData.get(node.id);
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
    const data = nodeData.get(node.id);
    if (!data || !data.hasMask) return false;
    
    const params = getImageDrawParams(node);
    if (!params) return false;
    
    // pos 已经是节点本地坐标
    const localX = pos[0];
    const localY = pos[1];
    
    // 转图像坐标
    const imgX = (localX - params.imgX) / params.scale;
    const imgY = (localY - params.imgY) / params.scale;
    
    // 检查是否在选区内
    const inRegion = imgX >= data.regionX && 
                     imgX <= data.regionX + data.regionWidth &&
                     imgY >= data.regionY && 
                     imgY <= data.regionY + data.regionHeight;
    
    if (inRegion) {
        dragging = {
            node: node,
            startImgX: imgX,
            startImgY: imgY,
            origRegionX: data.regionX,
            origRegionY: data.regionY
        };
        return true;  // 消费事件，阻止节点拖动
    }
    
    return false;
}

function onMouseMove(e, pos, node) {
    // 如果正在拖动
    if (dragging) {
        const data = nodeData.get(dragging.node.id);
        if (!data) return;
        
        const params = getImageDrawParams(dragging.node);
        if (!params) return;
        
        // pos 已经是节点本地坐标
        const localX = pos[0];
        const localY = pos[1];
        
        const imgX = (localX - params.imgX) / params.scale;
        const imgY = (localY - params.imgY) / params.scale;
        
        // 计算偏移
        const dx = imgX - dragging.startImgX;
        const dy = imgY - dragging.startImgY;
        
        // 更新选区位置
        data.regionX = Math.max(0, Math.min(dragging.origRegionX + dx, data.imageWidth - data.regionWidth));
        data.regionY = Math.max(0, Math.min(dragging.origRegionY + dy, data.imageHeight - data.regionHeight));
        
        // 同步到 widget
        const coordsWidget = dragging.node.widgets?.find(w => w.name === "region_coords");
        if (coordsWidget) {
            coordsWidget.value = JSON.stringify({
                x: Math.round(data.regionX),
                y: Math.round(data.regionY),
                width: data.regionWidth,
                height: data.regionHeight
            });
        }
        
        dragging.node.setDirtyCanvas(true);
    }
}

function onMouseUp() {
    dragging = null;
}

// ==================== 注册扩展 ====================

app.registerExtension({
    name: "InpaintRegionEditor",
    
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
        };
        
        // 自己绘制图像和选区框
        const origDrawBg = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function(ctx) {
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
                    const data = nodeData.get(node.id);
                    if (data && data.hasMask && data.maskBounds) {
                        data.regionX = Math.max(0, data.maskBounds.x - v);
                        data.regionY = Math.max(0, data.maskBounds.y - v);
                        data.regionWidth = data.maskBounds.width + v * 2;
                        data.regionHeight = data.maskBounds.height + v * 2;
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
