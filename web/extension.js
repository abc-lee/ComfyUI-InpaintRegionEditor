/**
 * InpaintRegionEditor Extension
 * 
 * 流程：图像 + 蒙版 <-> Photopea
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const PhotopeaBridge = {
    iframe: null,
    photopeaWindow: null,
    PHOTOPEA_ORIGIN: "https://www.photopea.com",

    init(iframe) {
        this.iframe = iframe;
        this.photopeaWindow = iframe.contentWindow;
        console.log("[PhotopeaBridge] Initialized");
    },

    async postMessage(message) {
        var self = this;
        return new Promise(function(resolve, reject) {
            if (!self.photopeaWindow) {
                reject(new Error("Photopea 未初始化"));
                return;
            }
            var responses = [];
            var timeoutId = null;
            var resolved = false;
            
            var handler = function(event) {
                if (event.origin !== self.PHOTOPEA_ORIGIN) return;
                responses.push(event.data);
                if (event.data === "done" && !resolved) {
                    resolved = true;
                    if (timeoutId) clearTimeout(timeoutId);
                    window.removeEventListener("message", handler);
                    resolve(responses);
                }
            };
            
            window.addEventListener("message", handler);
            self.photopeaWindow.postMessage(message, "*");
            
            timeoutId = setTimeout(function() {
                if (!resolved) {
                    resolved = true;
                    window.removeEventListener("message", handler);
                    reject(new Error("操作超时"));
                }
            }, 60000);
        });
    },

    async openImage(imageBlob) {
        var reader = new FileReader();
        var self = this;
        return new Promise(function(resolve, reject) {
            reader.onloadend = async function() {
                try {
                    await self.postMessage('app.open("' + reader.result + '", null, false);');
                    await self.postMessage('app.activeDocument.activeLayer.rasterize();');
                    console.log("[PhotopeaBridge] Image opened");
                    resolve();
                } catch (e) {
                    reject(e);
                }
            };
            reader.onerror = reject;
            reader.readAsDataURL(imageBlob);
        });
    },

    async openMaskAsLayer(maskBlob) {
        var reader = new FileReader();
        var self = this;
        return new Promise(function(resolve, reject) {
            reader.onloadend = async function() {
                try {
                    await self.postMessage('app.open("' + reader.result + '", null, true);');
                    console.log("[PhotopeaBridge] Mask opened as layer");
                    resolve();
                } catch (e) {
                    reject(e);
                }
            };
            reader.onerror = reject;
            reader.readAsDataURL(maskBlob);
        });
    },

    async exportImage() {
        console.log("[PhotopeaBridge] Exporting image...");
        var result = await this.postMessage('app.activeDocument.saveToOE("png");');
        
        for (var i = 0; i < result.length; i++) {
            if (result[i] instanceof ArrayBuffer) {
                console.log("[PhotopeaBridge] Image exported, size:", result[i].byteLength);
                return new Blob([result[i]], { type: "image/png" });
            }
        }
        throw new Error("导出图像失败：未收到图像数据");
    },

    async exportMaskFromSelection() {
        console.log("[PhotopeaBridge] Creating mask from selection...");
        
        // 先检查是否有选区
        var checkScript = '(function(){if(app.activeDocument.selection.bounds){return "HAS_SELECTION";}return "NO_SELECTION";})();';
        var checkResult = await this.postMessage('app.echoToOE(' + checkScript + ');');
        
        var hasSelection = false;
        for (var i = 0; i < checkResult.length; i++) {
            if (checkResult[i] === "HAS_SELECTION") {
                hasSelection = true;
                break;
            }
            if (checkResult[i] === "NO_SELECTION") {
                hasSelection = false;
                break;
            }
        }
        
        if (!hasSelection) {
            console.log("[PhotopeaBridge] No selection found");
            return null;
        }
        
        // 从选区创建蒙版
        var createMaskScript = '(function(){var d=app.activeDocument;d.selection.invert();d.selection.fill({r:0,g:0,b:0});d.selection.invert();d.selection.fill({r:255,g:255,b:255});d.saveToOE("png");d.undo();d.undo();})();';
        
        // 更简单的方法：创建新文档
        var simpleScript = '(function(){var d=app.activeDocument;var b=d.selection.bounds;var w=b[2]-b[0];var h=b[3]-b[1];var nd=app.documents.add(w,h);d.activeDocument=nd;nd.selection.selectAll();nd.selection.fill({r:255,g:255,b:255});d.activeDocument=d;nd.close(SaveOptions.DONOTSAVECHANGES);})();';
        
        // 最简单：导出选区内容
        var exportSelectionScript = '(function(){var d=app.activeDocument;if(!d.selection.bounds){app.echoToOE("NO_SELECTION");return;}var tempLayer=d.artLayers.add();tempLayer.name="__mask_temp__";d.selection.invert();d.selection.fill({r:0,g:0,b:0});d.selection.invert();d.selection.fill({r:255,g:255,b:255});d.saveToOE("png");tempLayer.remove();})();';
        
        var result = await this.postMessage(exportSelectionScript);
        
        // 检查是否有 NO_SELECTION
        for (var i = 0; i < result.length; i++) {
            if (result[i] === "NO_SELECTION") {
                console.log("[PhotopeaBridge] No selection");
                return null;
            }
        }
        
        for (var i = 0; i < result.length; i++) {
            if (result[i] instanceof ArrayBuffer) {
                console.log("[PhotopeaBridge] Mask exported, size:", result[i].byteLength);
                return new Blob([result[i]], { type: "image/png" });
            }
        }
        
        return null;
    }
};

const PhotopeaModal = {
    modal: null,
    node: null,
    imagePath: null,
    maskPath: null,
    isOpen: false,

    show(node, imagePath, maskPath) {
        this.node = node;
        this.imagePath = imagePath;
        this.maskPath = maskPath;
        this.isOpen = true;
        this.createUI();
    },

    createUI() {
        var self = this;
        this.modal && this.modal.remove();

        this.modal = document.createElement("div");
        this.modal.className = "photopea-modal";
        this.modal.innerHTML = 
            '<div class="photopea-container">' +
            '  <iframe id="photopea-iframe" src="https://www.photopea.com/"></iframe>' +
            '  <div class="photopea-toolbar">' +
            '    <div class="toolbar-left"><span class="toolbar-hint">在 Photopea 中编辑图像，用选区工具创建蒙版区域，然后保存</span></div>' +
            '    <div class="toolbar-right">' +
            '      <button id="btn-save-image" class="btn btn-success">保存图像</button>' +
            '      <button id="btn-save-mask" class="btn btn-primary">从选区保存蒙版</button>' +
            '      <button id="btn-cancel" class="btn btn-secondary">取消</button>' +
            '    </div>' +
            '  </div>' +
            '  <div class="photopea-statusbar"><span id="status-text">正在加载 Photopea...</span></div>' +
            '</div>';

        this.injectStyles();
        document.body.appendChild(this.modal);

        var iframe = document.getElementById("photopea-iframe");
        iframe.onload = async function() {
            if (!self.isOpen) return;
            PhotopeaBridge.init(iframe);
            self.setStatus("正在加载图像...");
            self.setupEventListeners();
            await self.loadImage();
        };
    },

    injectStyles() {
        if (document.getElementById("photopea-modal-styles")) return;
        var style = document.createElement("style");
        style.id = "photopea-modal-styles";
        style.textContent = ".photopea-modal{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.9);z-index:99999;display:flex;align-items:center;justify-content:center}.photopea-container{width:95%;height:95%;display:flex;flex-direction:column;background:#1e1e1e;border-radius:8px;overflow:hidden}#photopea-iframe{flex:1;width:100%;border:none}.photopea-toolbar{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:#2d2d2d;border-top:1px solid #444;gap:10px;flex-wrap:wrap}.toolbar-left{display:flex;align-items:center;gap:15px}.toolbar-right{display:flex;align-items:center;gap:10px}.toolbar-hint{color:#999;font-size:13px}.btn{padding:10px 18px;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:500}.btn:hover{transform:translateY(-1px);box-shadow:0 2px 8px rgba(0,0,0,0.3)}.btn-success{background:linear-gradient(135deg,#107c10,#0b5c0b);color:#fff}.btn-primary{background:linear-gradient(135deg,#0078d4,#106ebe);color:#fff}.btn-secondary{background:#555;color:#fff}.photopea-statusbar{padding:8px 16px;background:#1a1a1a;color:#888;font-size:12px}";
        document.head.appendChild(style);
    },

    setStatus(text) {
        if (!this.isOpen || !this.modal) return;
        var el = document.getElementById("status-text");
        if (el) el.textContent = text;
    },

    setupEventListeners() {
        var self = this;
        
        document.getElementById("btn-save-image").addEventListener("click", async function() {
            await self.saveImage();
        });
        
        document.getElementById("btn-save-mask").addEventListener("click", async function() {
            await self.saveMask();
        });
        
        document.getElementById("btn-cancel").addEventListener("click", function() {
            self.close();
        });
        
        this.escHandler = function(e) {
            if (e.key === "Escape") self.close();
        };
        document.addEventListener("keydown", this.escHandler);
    },

    parsePath(path) {
        var filename = path || "";
        var subfolder = "";
        var type = "input";
        
        if (!filename) return { filename: "", subfolder: "", type: "input" };
        
        var m = filename.match(/^(.+?)\s*\[(\w+)\]$/);
        if (m) {
            filename = m[1].trim();
            type = m[2];
        }
        var lastSlash = filename.lastIndexOf("/");
        if (lastSlash !== -1) {
            subfolder = filename.substring(0, lastSlash);
            filename = filename.substring(lastSlash + 1);
        }
        return { filename: filename, subfolder: subfolder, type: type };
    },

    async loadImage() {
        var self = this;
        try {
            var p = this.parsePath(this.imagePath);
            if (!p.filename) {
                this.setStatus("没有图像");
                return;
            }
            
            var url = "/view?filename=" + encodeURIComponent(p.filename) + "&type=" + p.type;
            if (p.subfolder) url += "&subfolder=" + encodeURIComponent(p.subfolder);
            
            console.log("[InpaintRegionEditor] Loading image:", url);
            
            var resp = await fetch(url);
            if (!resp.ok) {
                this.setStatus("加载失败: " + resp.status);
                return;
            }
            
            var imageBlob = await resp.blob();
            await PhotopeaBridge.openImage(imageBlob);
            
            this.setStatus("图像已加载。用选区工具(M)创建蒙版区域，然后点击'从选区保存蒙版'");
            
        } catch (e) {
            console.error("[InpaintRegionEditor] Load error:", e);
            this.setStatus("加载失败: " + e.message);
        }
    },

    async saveImage() {
        var self = this;
        if (!this.isOpen) return;
        
        try {
            this.setStatus("正在导出图像...");
            
            var imageBlob = await PhotopeaBridge.exportImage();
            
            this.setStatus("正在上传图像...");
            
            var result = await this.uploadToComfyUI(imageBlob, "edited.png");
            
            if (result.name) {
                var imageWidget = this.node.widgets && this.node.widgets.find(function(w) { return w.name === "image"; });
                if (imageWidget) imageWidget.value = result.name;
            }
            
            this.node.setDirtyCanvas(true);
            this.setStatus("图像已保存");
            
        } catch (e) {
            console.error("[InpaintRegionEditor] Save image error:", e);
            this.setStatus("保存失败: " + e.message);
            alert("保存图像失败: " + e.message);
        }
    },

    async saveMask() {
        var self = this;
        if (!this.isOpen) return;
        
        try {
            this.setStatus("正在从选区创建蒙版...");
            
            var maskBlob = await PhotopeaBridge.exportMaskFromSelection();
            
            if (!maskBlob) {
                this.setStatus("没有选区，请先用选区工具(M)绘制区域");
                alert("请先用选区工具（快捷键 M）绘制要重绘的区域，然后再保存蒙版");
                return;
            }
            
            this.setStatus("正在上传蒙版...");
            
            var result = await this.uploadToComfyUI(maskBlob, "mask.png");
            
            if (result.name) {
                var maskPathWidget = this.node.widgets && this.node.widgets.find(function(w) { return w.name === "mask_path"; });
                if (maskPathWidget) maskPathWidget.value = result.name;
            }
            
            this.node.setDirtyCanvas(true);
            this.setStatus("蒙版已保存");
            
        } catch (e) {
            console.error("[InpaintRegionEditor] Save mask error:", e);
            this.setStatus("保存失败: " + e.message);
            alert("保存蒙版失败: " + e.message);
        }
    },

    async uploadToComfyUI(blob, filename) {
        var fd = new FormData();
        fd.append("image", blob, filename);
        fd.append("type", "input");
        var resp = await api.fetchApi("/upload/image", { method: "POST", body: fd });
        return await resp.json();
    },

    close() {
        this.isOpen = false;
        if (this.escHandler) {
            document.removeEventListener("keydown", this.escHandler);
            this.escHandler = null;
        }
        if (this.modal) {
            this.modal.remove();
            this.modal = null;
        }
        this.node = null;
    }
};

app.registerExtension({
    name: "comfyui.inpaint_region_editor",
    
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "InpaintRegionEditor") return;
        
        var getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function(canvas, options) {
            getExtraMenuOptions && getExtraMenuOptions.apply(this, arguments);
            
            var node = this;
            options.push(null);
            options.push({
                content: "Open in Photopea",
                callback: function() {
                    var imageWidget = node.widgets && node.widgets.find(function(w) { return w.name === "image"; });
                    var maskPathWidget = node.widgets && node.widgets.find(function(w) { return w.name === "mask_path"; });
                    
                    if (imageWidget && imageWidget.value) {
                        PhotopeaModal.show(node, imageWidget.value, maskPathWidget ? maskPathWidget.value : null);
                    } else {
                        alert("请先上传图像");
                    }
                }
            });
            return options;
        };
        
        var onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            var result = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            this.addWidget("STRING", "mask_path", "", function() {}, { serialize: true });
            this.addWidget("STRING", "mask_bounds", "{}", function() {}, { serialize: true });
            return result;
        };
    }
});

console.log("[InpaintRegionEditor] Extension loaded");
