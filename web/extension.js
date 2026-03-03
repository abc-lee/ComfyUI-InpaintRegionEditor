/**
 * InpaintRegionEditor Extension
 * 
 * 完全自己控制图像渲染，不依赖 ComfyUI 的图像预览
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ==================== i18n 多语言支持 ====================

const i18n = {
    data: null,
    loaded: false,
    
    // 获取当前语言
    getLocale() {
        return localStorage['AGL.Locale'] || localStorage['Comfy.Settings.AGL.Locale'] || 'en-US';
    },
    
    // 加载语言文件
    async load() {
        if (this.loaded) return;
        const locale = this.getLocale();
        const lang = locale.startsWith('zh') ? 'zh' : 'en';
        try {
            const resp = await fetch(`/extensions/InpaintRegionEditor/locales/${lang}/main.json`);
            if (resp.ok) {
                this.data = await resp.json();
                console.log('i18n loaded:', lang, this.data);
            } else {
                console.warn('i18n response not ok:', resp.status);
            }
        } catch (e) {
            console.warn('Failed to load locale:', e);
        }
        this.loaded = true;
    },
    
    // 获取翻译
    t(key) {
        if (!this.data) return key;
        const keys = key.split('.');
        let value = this.data;
        for (const k of keys) {
            if (value && typeof value === 'object' && k in value) {
                value = value[k];
            } else {
                return key; // 找不到返回 key
            }
        }
        return typeof value === 'string' ? value : key;
    }
};

// 快捷函数（延迟获取，确保已加载）
function t(key) {
    return i18n.t(key);
}

// ==================== UPNG.js 动态加载 ====================
let UPNG = null;
async function loadUPNG() {
    if (UPNG) return UPNG;
    
    // 先加载 pako（UPNG 依赖）
    if (!window.pako) {
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js';
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }
    
    // 再加载 UPNG
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/upng-js/2.1.0/UPNG.min.js';
        script.onload = () => { UPNG = window.UPNG; resolve(UPNG); };
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

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
    ppState.modal.innerHTML = `<div class="pp-container"><iframe id="pp-iframe" src="https://www.photopea.com/"></iframe><div class="pp-toolbar"><span class="pp-hint">${t('photopea.editHint')}</span><div><button id="pp-save" class="pp-btn pp-save">${t('photopea.save')}</button><button id="pp-cancel" class="pp-btn pp-cancel">${t('photopea.cancel')}</button></div></div><div class="pp-status" id="pp-status">${t('photopea.loading')}</div></div>`;
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
        setStatus(t('photopea.loaded'));
    } catch (e) { setStatus(t('photopea.error') + e.message); }
}

async function saveImg() {
    if (!ppState.open) return;
    try {
        setStatus(t('photopea.exporting'));
        const blob = await PhotopeaBridge.exportImage("png");
        setStatus(t('photopea.uploading'));
        const fd = new FormData();
        fd.append("image", blob, "edited_" + Date.now() + ".png");
        fd.append("type", "input");
        const resp = await api.fetchApi("/upload/image", { method: "POST", body: fd });
        const result = await resp.json();
        if (result.name) {
            const w = ppState.node.widgets?.find(x => x.name === "image");
            if (w) { w.value = result.name; if (w.callback) w.callback(result.name); }
            ppState.node.setDirtyCanvas(true);
            setStatus(t('photopea.saved'));
            setTimeout(closePhotopeaModal, 500);
        }
    } catch (e) { setStatus(t('photopea.error') + e.message); }
}

function closePhotopeaModal() {
    ppState.open = false;
    if (ppState.modal) { ppState.modal.remove(); ppState.modal = null; }
    ppState.node = null; ppState.path = null;
}

// ==================== Photopea 蒙版编辑模式 ====================

let ppMaskState = { modal: null, node: null, path: null, open: false, mode: "mask" };

function showPhotopeaMaskModal(node, imagePath) {
    ppMaskState = { modal: null, node, path: imagePath, open: true, mode: "mask" };
    
    if (!document.getElementById("pp-style")) {
        const style = document.createElement("style");
        style.id = "pp-style";
        style.textContent = `.pp-modal{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.9);z-index:99999;display:flex;align-items:center;justify-content:center}.pp-container{width:95%;height:95%;display:flex;flex-direction:column;background:#1e1e1e;border-radius:8px;overflow:hidden}#pp-iframe{flex:1;width:100%;border:none}.pp-toolbar{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:#2d2d2d;border-top:1px solid #444}.pp-hint{color:#999;font-size:13px}.pp-btn{padding:10px 18px;border:none;border-radius:6px;cursor:pointer;font-size:14px;margin-left:10px}.pp-save{background:#107c10;color:#fff}.pp-cancel{background:#555;color:#fff}.pp-status{padding:8px 16px;background:#1a1a1a;color:#888;font-size:12px}`;
        document.head.appendChild(style);
    }
    
    ppMaskState.modal = document.createElement("div");
    ppMaskState.modal.className = "pp-modal";
    ppMaskState.modal.innerHTML = `<div class="pp-container"><iframe id="pp-iframe" src="https://www.photopea.com/"></iframe><div class="pp-toolbar"><span class="pp-hint">${t('maskEditor.hint')}</span><div><button id="pp-save" class="pp-btn pp-save">${t('maskEditor.saveMask')}</button><button id="pp-cancel" class="pp-btn pp-cancel">${t('photopea.cancel')}</button></div></div><div class="pp-status" id="pp-status">${t('photopea.loading')}</div></div>`;
    document.body.appendChild(ppMaskState.modal);
    
    document.getElementById("pp-save").onclick = saveMaskImg;
    document.getElementById("pp-cancel").onclick = closePhotopeaMaskModal;
    document.getElementById("pp-iframe").onload = function() { 
        if (ppMaskState.open) { 
            PhotopeaBridge.init(this); 
            loadImgForMask(); 
        } 
    };
}

function setMaskStatus(t) { const el = document.getElementById("pp-status"); if (el) el.textContent = t; }

async function loadImgForMask() {
    try {
        // 解析文件路径
        let filename = ppMaskState.path, type = "input", subfolder = "";
        const m = ppMaskState.path.match(/^(.+?)\s*\[(\w+)\]$/);
        if (m) { filename = m[1].trim(); type = m[2]; }
        const idx = filename.lastIndexOf("/");
        if (idx !== -1) { subfolder = filename.substring(0, idx); filename = filename.substring(idx + 1); }
        
        let baseUrl = "/view?filename=" + encodeURIComponent(filename) + "&type=" + encodeURIComponent(type);
        if (subfolder) baseUrl += "&subfolder=" + encodeURIComponent(subfolder);
        
        // 关键修复：分别获取 RGB 和 Alpha，绑过 Canvas 的 premultiplied alpha 问题
        // 1. 获取完整 RGB（不会被掏窟窿）
        setMaskStatus(t('maskEditor.loadRgb'));
        let rgbUrl = baseUrl + "&channel=rgb";
        const rgbResp = await fetch(rgbUrl);
        if (!rgbResp.ok) throw new Error("HTTP " + rgbResp.status);
        const rgbBlob = await rgbResp.blob();
        
        // 2. 获取 Alpha 通道（用于创建蒙版层）
        setMaskStatus(t('maskEditor.loadAlpha'));
        let alphaUrl = baseUrl + "&channel=a";
        const alphaResp = await fetch(alphaUrl);
        let alphaBlob = null;
        if (alphaResp.ok) {
            alphaBlob = await alphaResp.blob();
        }
        
        // 3. 从 Alpha 通道创建蒙版层
        setMaskStatus(t('maskEditor.prepareMask'));
        const maskBlob = await createMaskFromAlpha(alphaBlob);
        
        // 4. 转换为 base64
        setMaskStatus(t('maskEditor.converting'));
        const rgbBase64 = await blobToBase64(rgbBlob);
        const maskBase64 = await blobToBase64(maskBlob);
        
        console.log("RGB blob 大小:", rgbBlob.size);
        console.log("Alpha blob 大小:", alphaBlob?.size);
        console.log("蒙版 blob 大小:", maskBlob.size);
        
        // 5. 先打开 RGB 图像（完整 RGB，没窟窿）
        setMaskStatus(t('maskEditor.loadImageLayer'));
        await PhotopeaBridge.postMessage('app.open("' + rgbBase64 + '", null, false);');
        
        // 6. 等待一下确保文档加载完成
        await new Promise(r => setTimeout(r, 500));
        
        // 7. 将蒙版作为新图层粘贴到当前文档
        setMaskStatus(t('maskEditor.loadMaskLayer'));
        await PhotopeaBridge.postMessage('app.open("' + maskBase64 + '", null, true);');
        
        // 8. 设置图层名称
        await new Promise(r => setTimeout(r, 300));
        await PhotopeaBridge.postMessage(`
            (function() {
                var doc = app.activeDocument;
                if (doc.layers.length >= 2) {
                    doc.layers[0].name = "${t('maskEditor.maskLayerName')}";
                    doc.layers[doc.layers.length - 1].name = "${t('maskEditor.referenceImage')}";
                }
            })();
        `);
        
        setMaskStatus(t('maskEditor.ready'));
    } catch (e) { 
        setMaskStatus(t('photopea.error') + e.message);
        console.error(e);
    }
}

// 从 Alpha 通道创建蒙版层
async function createMaskFromAlpha(alphaBlob) {
    return new Promise((resolve) => {
        if (!alphaBlob) {
            // 没有 Alpha 数据，创建透明蒙版
            const canvas = document.createElement("canvas");
            canvas.width = 512;
            canvas.height = 512;
            canvas.toBlob((blob) => resolve(blob), "image/png");
            return;
        }
        
        const img = new Image();
        img.onload = function() {
            const canvas = document.createElement("canvas");
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext("2d");
            
            // channel=a 返回的是 RGBA 图像，Alpha 值在 Alpha 通道
            ctx.drawImage(img, 0, 0);
            const imageData = ctx.getImageData(0, 0, img.width, img.height);
            const pixels = imageData.data;
            
            // 检查是否有遮罩（Alpha < 255 表示有遮罩）
            let hasMask = false;
            for (let i = 0; i < pixels.length; i += 4) {
                if (pixels[i + 3] < 255) {  // Alpha 通道
                    hasMask = true;
                    break;
                }
            }
            
            if (hasMask) {
                // 从 Alpha 创建蒙版层
                // channel=a 返回的 Alpha：255=不透明，0=透明
                // 我们需要：透明区域(Alpha=0) → 黑色不透明蒙版
                ctx.clearRect(0, 0, img.width, img.height);
                
                const maskData = ctx.createImageData(img.width, img.height);
                for (let i = 0; i < pixels.length; i += 4) {
                    const alphaValue = pixels[i + 3];  // Alpha 通道
                    if (alphaValue < 255) {
                        const maskAlpha = 255 - alphaValue;  // 反转
                        maskData.data[i] = 0;      // 黑色
                        maskData.data[i + 1] = 0;
                        maskData.data[i + 2] = 0;
                        maskData.data[i + 3] = maskAlpha;
                    }
                }
                ctx.putImageData(maskData, 0, 0);
                console.log("已有蒙版，已转换为蒙版层");
            } else {
                ctx.clearRect(0, 0, img.width, img.height);
                console.log("创建透明蒙版，尺寸:", img.width, "x", img.height);
            }
            
            canvas.toBlob((blob) => resolve(blob), "image/png");
        };
        img.onerror = () => {
            const canvas = document.createElement("canvas");
            canvas.width = 512;
            canvas.height = 512;
            canvas.toBlob((blob) => resolve(blob), "image/png");
        };
        img.src = URL.createObjectURL(alphaBlob);
    });
}

async function getOrCreateMaskBlob(node, imgBlob) {
    // 检查图像是否有 Alpha 通道（已有蒙版）
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = async function() {
            const canvas = document.createElement("canvas");
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0);
            
            const imageData = ctx.getImageData(0, 0, img.width, img.height);
            const pixels = imageData.data;
            
            // 检查是否有透明像素
            let hasMask = false;
            for (let i = 3; i < pixels.length; i += 4) {
                if (pixels[i] < 255) {
                    hasMask = true;
                    break;
                }
            }
            
            if (hasMask) {
                // 从 Alpha 通道创建蒙版层
                // 转换逻辑（与保存时相反）：
                // - 原图 Alpha = 0（遮罩）→ 蒙版层黑色不透明
                // - 原图 Alpha = 255（无遮罩）→ 蒙版层透明
                // - 原图 Alpha = 中间值（羽化）→ 蒙版层黑色半透明
                
                // 先清除 canvas
                ctx.clearRect(0, 0, img.width, img.height);
                
                const maskData = ctx.createImageData(img.width, img.height);
                for (let i = 0; i < pixels.length; i += 4) {
                    const alpha = pixels[i + 3];  // 原图的 Alpha
                    if (alpha < 255) {
                        // 有遮罩的区域：画黑色
                        // alpha 越小 = 越遮罩 = 蒙版层越不透明
                        const maskAlpha = 255 - alpha;  // 反转
                        maskData.data[i] = 0;      // 黑色
                        maskData.data[i + 1] = 0;
                        maskData.data[i + 2] = 0;
                        maskData.data[i + 3] = maskAlpha;
                    }
                    // alpha = 255 的像素保持透明（maskData.data[i+3] 默认是 0）
                }
                ctx.putImageData(maskData, 0, 0);
                console.log("已有蒙版，已转换为蒙版层");
            } else {
                // 创建透明蒙版（用户在上面画黑色 = 遮罩）
                // 清除 canvas，保持完全透明
                ctx.clearRect(0, 0, img.width, img.height);
                console.log("创建透明蒙版，尺寸:", img.width, "x", img.height);
            }
            
            // 导出为 PNG，确保保留透明通道
            canvas.toBlob((blob) => {
                console.log("蒙版 blob 大小:", blob.size, "type:", blob.type);
                resolve(blob);
            }, "image/png");
        };
        img.onerror = () => {
            // 出错时返回白色蒙版
            const canvas = document.createElement("canvas");
            canvas.width = 512;
            canvas.height = 512;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "white";
            ctx.fillRect(0, 0, 512, 512);
            canvas.toBlob((blob) => resolve(blob), "image/png");
        };
        img.src = URL.createObjectURL(imgBlob);
    });
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

async function saveMaskImg() {
    if (!ppMaskState.open) return;
    try {
        // 提前加载 UPNG.js
        setMaskStatus(t('maskEditor.prepareEncoder'));
        try {
            await loadUPNG();
        } catch (e) {
            console.error("加载 UPNG.js 失败:", e);
        }
        
        setMaskStatus(t('maskEditor.exportMask'));
        
        // 先检查图层信息
        const checkScript = `
            (function() {
                var doc = app.activeDocument;
                var info = "图层: " + doc.layers.length + "\\n";
                for (var i = 0; i < doc.layers.length; i++) {
                    info += i + ": " + doc.layers[i].name + " visible=" + doc.layers[i].visible + "\\n";
                }
                app.echoToOE(info);
            })();
        `;
        const checkResult = await PhotopeaBridge.postMessage(checkScript);
        console.log("图层信息:", checkResult);
        
        // 导出脚本：隐藏图像层，只导出蒙版层
        const exportScript = `
            (function() {
                var doc = app.activeDocument;
                // 隐藏所有图层
                for (var i = 0; i < doc.layers.length; i++) {
                    doc.layers[i].visible = false;
                }
                // 只显示最上层（蒙版层，索引0）
                doc.layers[0].visible = true;
                // 导出
                doc.saveToOE("png");
            })();
        `;
        
        const result = await PhotopeaBridge.postMessage(exportScript);
        
        // 提取 ArrayBuffer
        let maskBlob = null;
        for (let i = 0; i < result.length; i++) {
            if (result[i] instanceof ArrayBuffer) {
                maskBlob = new Blob([result[i]], { type: "image/png" });
                break;
            }
        }
        
        if (!maskBlob) throw new Error(t('maskEditor.noMaskData'));
        
        setMaskStatus(t('maskEditor.processMask'));
        
        // 获取原始图像
        const originalImageBlob = await getOriginalImageBlob(ppMaskState.path);
        
        // 合并蒙版到原图
        const finalBlob = await mergeMaskToImage(originalImageBlob, maskBlob);
        
        setMaskStatus(t('photopea.uploading'));
        const fd = new FormData();
        fd.append("image", finalBlob, "mask_" + Date.now() + ".png");
        fd.append("type", "input");
        
        const resp = await api.fetchApi("/upload/image", { method: "POST", body: fd });
        const uploadResult = await resp.json();
        
        if (uploadResult.name) {
            const w = ppMaskState.node.widgets?.find(x => x.name === "image");
            if (w) { 
                w.value = uploadResult.name; 
                if (w.callback) w.callback(uploadResult.name); 
            }
            ppMaskState.node.setDirtyCanvas(true);
            setMaskStatus(t('maskEditor.maskSaved'));
            setTimeout(closePhotopeaMaskModal, 500);
        }
    } catch (e) { 
        setMaskStatus(t('photopea.error') + e.message);
        console.error(e);
    }
}

async function getOriginalImageBlob(imagePath) {
    let filename = imagePath, type = "input", subfolder = "";
    const m = imagePath.match(/^(.+?)\s*\[(\w+)\]$/);
    if (m) { filename = m[1].trim(); type = m[2]; }
    const idx = filename.lastIndexOf("/");
    if (idx !== -1) { subfolder = filename.substring(0, idx); filename = filename.substring(idx + 1); }
    
    // 关键：添加 channel=rgb 参数，确保获取完整 RGB 数据（不被掏窟窿）
    let url = "/view?filename=" + encodeURIComponent(filename) + "&type=" + encodeURIComponent(type) + "&channel=rgb";
    if (subfolder) url += "&subfolder=" + encodeURIComponent(subfolder);
    
    console.log("获取原图 URL:", url);
    const resp = await fetch(url);
    return await resp.blob();
}

async function mergeMaskToImage(imageBlob, maskBlob) {
    // 加载 UPNG.js（用于绑过 Canvas 的 premultiplied alpha 问题）
    try {
        await loadUPNG();
    } catch (e) {
        console.error("加载 UPNG.js 失败:", e);
    }
    
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = async function() {
            const maskImg = new Image();
            maskImg.onload = async function() {
                const w = img.width;
                const h = img.height;
                
                const canvas = document.createElement("canvas");
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext("2d");
                
                // 绘制原图
                ctx.drawImage(img, 0, 0);
                
                // 获取图像数据
                const imageData = ctx.getImageData(0, 0, w, h);
                const pixels = imageData.data;
                
                // 创建临时 canvas 读取蒙版灰度
                const maskCanvas = document.createElement("canvas");
                maskCanvas.width = w;
                maskCanvas.height = h;
                const maskCtx = maskCanvas.getContext("2d");
                maskCtx.drawImage(maskImg, 0, 0, w, h);
                const maskData = maskCtx.getImageData(0, 0, w, h);
                const maskPixels = maskData.data;
                
                // 合并蒙版到 Alpha 通道
                // 蒙版层逻辑（用户画黑色）：
                // - 黑色不透明（maskAlpha=255）→ 遮罩 → Alpha = 0
                // - 黑色半透明（maskAlpha=128）→ 羽化 → Alpha = 128
                // - 完全透明（maskAlpha=0）→ 不遮罩 → Alpha = 255
                // 公式：最终 Alpha = 255 - maskAlpha
                
                let alphaSamples = [];
                for (let i = 0; i < pixels.length; i += 4) {
                    const maskAlpha = maskPixels[i + 3];  // 蒙版层的透明度
                    const finalAlpha = 255 - maskAlpha;   // 反转：用户画的 = 遮罩
                    pixels[i + 3] = finalAlpha;
                    
                    // 收集羽化样本
                    if (alphaSamples.length < 10 && maskAlpha > 0 && maskAlpha < 255) {
                        alphaSamples.push({ maskAlpha, finalAlpha });
                    }
                }
                
                if (alphaSamples.length > 0) {
                    console.log("羽化样本 (maskAlpha → finalAlpha):", alphaSamples);
                }
                
                console.log("合并完成，尺寸:", w, "x", h);
                
                // 使用 UPNG.js 编码（保留 Alpha=0 时的 RGB 数据）
                if (UPNG) {
                    console.log("使用 UPNG.js 编码 PNG");
                    const rgbaBuffer = imageData.data.buffer;
                    const pngBuffer = UPNG.encode([rgbaBuffer], w, h, 0);
                    const blob = new Blob([pngBuffer], { type: "image/png" });
                    console.log("UPNG 编码完成，blob 大小:", blob.size);
                    resolve(blob);
                } else {
                    // 回退到 Canvas（会丢失 Alpha=0 的 RGB）
                    console.log("UPNG 不可用，使用 Canvas 编码");
                    ctx.putImageData(imageData, 0, 0);
                    canvas.toBlob((blob) => resolve(blob), "image/png");
                }
            };
            maskImg.src = URL.createObjectURL(maskBlob);
        };
        img.src = URL.createObjectURL(imageBlob);
    });
}

function closePhotopeaMaskModal() {
    ppMaskState.open = false;
    if (ppMaskState.modal) { ppMaskState.modal.remove(); ppMaskState.modal = null; }
    ppMaskState.node = null; ppMaskState.path = null;
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
    
    console.log("loadImageAndDetectMask 开始:", imageName);
    
    try {
        // 解析文件名
        let filename = imageName, type = "input", subfolder = "";
        const m = imageName.match(/^(.+?)\s*\[(\w+)\]$/);
        if (m) { filename = m[1].trim(); type = m[2]; }
        const idx = filename.lastIndexOf("/");
        if (idx !== -1) { subfolder = filename.substring(0, idx); filename = filename.substring(idx + 1); }
        
        // 加载完整图像（带 Alpha，用于显示蒙版效果）
        let url = "/view?filename=" + encodeURIComponent(filename) + "&type=" + encodeURIComponent(type);
        if (subfolder) url += "&subfolder=" + encodeURIComponent(subfolder);
        
        console.log("图像 URL:", url);
        
        const resp = await fetch(url);
        if (!resp.ok) return;
        const blob = await resp.blob();
        console.log("图像 blob 大小:", blob.size);
        
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
                        minX = Math.min(minX, x);
                        minY = Math.min(minY, y);
                        maxX = Math.max(maxX, x);
                        maxY = Math.max(maxY, y);
                    }
                }
            }
            
            const padding = node.widgets?.find(w => w.name === "padding")?.value ?? 64;
            
            // 存储数据（包含原始URL供 MaskEditor 使用）
            const data = {
                image: img,
                imageUrl: url,  // 保存原始 URL
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
        const labelText = t('node.referenceArea') + " " + Math.round(data.regionWidth) + "×" + Math.round(data.regionHeight);
        const labelWidth = ctx.measureText(labelText).width + 6;
        ctx.fillRect(rx + 2, ry + 2, labelWidth, 10);
        ctx.fillStyle = "#000";
        ctx.fillText(labelText, rx + 3, ry + 9);
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
    
    async init() {
        // 初始化多语言
        await i18n.load();
        
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
        // 确保语言文件加载完成
        await i18n.load();
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
                content: t('menu.editImage'),
                callback: function() { imgW?.value ? showPhotopeaModal(node, imgW.value) : alert(t('menu.selectImageFirst')); }
            });
            options.push({
                content: t('menu.editMask'),
                callback: function() { imgW?.value ? showPhotopeaMaskModal(node, imgW.value) : alert(t('menu.selectImageFirst')); }
            });
            // Open in MaskEditor - 使用正确的命令调用
            options.push({
                content: t('menu.openMaskEditor'),
                callback: function() {
                    if (!imgW?.value) { alert(t('menu.selectImageFirst')); return; }
                    const data = nodeImageData.get(node.id);
                    if (!data?.imageUrl) { alert(t('menu.imageNotLoaded')); return; }
                    
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
            
            // 确保 region_coords hidden widget 存在
            let coordsWidget = node.widgets?.find(w => w.name === "region_coords");
            if (!coordsWidget) {
                // ComfyUI hidden widget 需要手动创建
                coordsWidget = node.addWidget("STRING", "region_coords", "{}", () => {}, {
                    serialize: true,
                    hidden: true
                });
            }
            
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
        
        // 从工作流加载时确保 widget 存在
        const origConfigure = nodeType.prototype.configure;
        nodeType.prototype.configure = function(info) {
            if (origConfigure) origConfigure.apply(this, arguments);
            
            const node = this;
            // 确保 region_coords widget 存在
            let coordsWidget = node.widgets?.find(w => w.name === "region_coords");
            if (!coordsWidget) {
                coordsWidget = node.addWidget("STRING", "region_coords", "{}", () => {}, {
                    serialize: true
                });
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
