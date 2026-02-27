/**
 * InpaintRegionEditor Extension
 * 
 * 流程：
 * 1. 打开：图像 + 蒙版 -> Photopea
 * 2. 编辑：用户编辑图像和蒙版
 * 3. 保存：图像 + 蒙版 -> ComfyUI
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
        return new Promise((resolve, reject) => {
            if (!this.photopeaWindow) {
                reject(new Error("Photopea 未初始化"));
                return;
            }
            const responses = [];
            let timeoutId = null;
            const handler = (event) => {
                if (event.origin !== this.PHOTOPEA_ORIGIN) return;
                responses.push(event.data);
                if (event.data === "done") {
                    if (timeoutId) clearTimeout(timeoutId);
                    window.removeEventListener("message", handler);
                    resolve(responses);
                }
            };
            window.addEventListener("message", handler);
            this.photopeaWindow.postMessage(message, "*");
            timeoutId = setTimeout(() => {
                window.removeEventListener("message", handler);
                reject(new Error("超时"));
            }, 120000);
        });
    },

    async openImageWithMask(imageBlob, maskBlob) {
        const imageBase64 = await this.blobToBase64(imageBlob);
        await this.postMessage('app.open("' + imageBase64 + '", null, false);');
        
        if (maskBlob) {
            const maskBase64 = await this.blobToBase64(maskBlob);
            await this.postMessage('app.open("' + maskBase64 + '", null, true);');
            var script = '(function(){var d=app.activeDocument;if(d.layers.length<2)return;var m=d.activeLayer;var i=d.layers[d.layers.length-1];d.activeLayer=m;var b=m.bounds;if(b){d.selection.select([[b[0],b[1]],[b[2],b[1]],[b[2],b[3]],[b[0],b[3]]]);d.selection.copy();d.activeLayer=i;i.addMask();d.activeChannels=[d.channels.getByName("Mask")];d.selection.selectAll();d.paste();m.remove();d.activeChannels=d.componentChannels;}})();';
            await this.postMessage(script);
        }
        await this.postMessage('app.activeDocument.activeLayer.rasterize();');
        console.log("[PhotopeaBridge] Image opened");
    },

    async exportImage() {
        var result = await this.postMessage('app.activeDocument.saveToOE("png");');
        var arrayBuffer = result.find(r => r instanceof ArrayBuffer);
        if (!arrayBuffer) throw new Error("导出图像失败");
        return new Blob([arrayBuffer], { type: "image/png" });
    },

    async exportMask() {
        var script = '(function(){var d=app.activeDocument;var l=d.activeLayer;if(!l.mask||!l.mask.enabled){app.echoToOE("NO_MASK");return;}var t=d.artLayers.add();t.name="__temp__";var mc=d.channels.getByName("Mask");d.activeChannels=[mc];d.selection.selectAll();d.selection.copy();d.activeChannels=d.componentChannels;d.activeLayer=t;d.selection.selectAll();d.paste();l.visible=false;d.saveToOE("png");t.remove();l.visible=true;d.activeLayer=l;})();';
        var result = await this.postMessage(script);
        if (result.indexOf("NO_MASK") >= 0) return null;
        var arrayBuffer = result.find(r => r instanceof ArrayBuffer);
        return arrayBuffer ? new Blob([arrayBuffer], { type: "image/png" }) : null;
    },

    blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            var reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }
};

const PhotopeaModal = {
    modal: null,
    node: null,
    imagePath: null,
    maskPath: null,

    show(node, imagePath, maskPath) {
        this.node = node;
        this.imagePath = imagePath;
        this.maskPath = maskPath;
        this.createUI();
    },

    createUI() {
        this.modal && this.modal.remove();
        this.modal = document.createElement("div");
        this.modal.className = "photopea-modal";
        this.modal.innerHTML = "<div class='photopea-container'><iframe id='photopea-iframe' src='https://www.photopea.com/'></iframe><div class='photopea-toolbar'><div class='toolbar-left'><span class='toolbar-hint'>编辑图像和蒙版后，点击保存</span></div><div class='toolbar-right'><button id='btn-save' class='btn btn-success'>保存图像和蒙版</button><button id='btn-cancel' class='btn btn-secondary'>取消</button></div></div><div class='photopea-statusbar'><span id='status-text'>正在加载 Photopea...</span></div></div>";
        this.injectStyles();
        document.body.appendChild(this.modal);
        var iframe = document.getElementById("photopea-iframe");
        var self = this;
        iframe.onload = async () => {
            PhotopeaBridge.init(iframe);
            document.getElementById("status-text").textContent = "正在加载图像...";
            self.setupEventListeners();
            await self.loadImageAndMask();
        };
    },

    injectStyles() {
        if (document.getElementById("photopea-modal-styles")) return;
        var style = document.createElement("style");
        style.id = "photopea-modal-styles";
        style.textContent = ".photopea-modal{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.9);z-index:99999;display:flex;align-items:center;justify-content:center}.photopea-container{width:95%;height:95%;display:flex;flex-direction:column;background:#1e1e1e;border-radius:8px;overflow:hidden}#photopea-iframe{flex:1;width:100%;border:none}.photopea-toolbar{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:#2d2d2d;border-top:1px solid #444;gap:10px}.toolbar-left{display:flex;align-items:center;gap:15px}.toolbar-right{display:flex;align-items:center;gap:10px}.toolbar-hint{color:#999;font-size:13px}.btn{padding:10px 18px;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:500}.btn:hover{transform:translateY(-1px);box-shadow:0 2px 8px rgba(0,0,0,0.3)}.btn-success{background:linear-gradient(135deg,#107c10,#0b5c0b);color:#fff}.btn-secondary{background:#555;color:#fff}.photopea-statusbar{padding:8px 16px;background:#1a1a1a;color:#888;font-size:12px}";
        document.head.appendChild(style);
    },

    setupEventListeners() {
        var self = this;
        document.getElementById("btn-save").addEventListener("click", async () => { await self.saveAll(); });
        document.getElementById("btn-cancel").addEventListener("click", () => { self.close(); });
        this.escHandler = (e) => { if (e.key === "Escape") self.close(); };
        document.addEventListener("keydown", this.escHandler);
    },

    parsePath(path) {
        var filename = path, subfolder = "", type = "input";
        var m = path.match(/^(.+?)\s*\[(\w+)\]$/);
        if (m) { filename = m[1].trim(); type = m[2]; }
        var lastSlash = filename.lastIndexOf("/");
        if (lastSlash !== -1) { subfolder = filename.substring(0, lastSlash); filename = filename.substring(lastSlash + 1); }
        return { filename, subfolder, type };
    },

    async loadImageAndMask() {
        try {
            var p = this.parsePath(this.imagePath);
            var url = "/view?filename=" + encodeURIComponent(p.filename) + "&type=" + p.type;
            if (p.subfolder) url += "&subfolder=" + encodeURIComponent(p.subfolder);
            console.log("[InpaintRegionEditor] Loading image:", url);
            var resp = await fetch(url);
            if (!resp.ok) throw new Error("加载失败: " + resp.status);
            var imageBlob = await resp.blob();

            var maskBlob = null;
            if (this.maskPath) {
                try {
                    var mp = this.parsePath(this.maskPath);
                    var murl = "/view?filename=" + encodeURIComponent(mp.filename) + "&type=" + mp.type;
                    if (mp.subfolder) murl += "&subfolder=" + encodeURIComponent(mp.subfolder);
                    var mresp = await fetch(murl);
                    if (mresp.ok) maskBlob = await mresp.blob();
                } catch (e) { console.log("[InpaintRegionEditor] No mask"); }
            }

            await PhotopeaBridge.openImageWithMask(imageBlob, maskBlob);
            document.getElementById("status-text").textContent = maskBlob ? "图像和蒙版已加载" : "图像已加载";
        } catch (e) {
            console.error("[InpaintRegionEditor] Load error:", e);
            document.getElementById("status-text").textContent = "加载失败: " + e.message;
        }
    },

    async saveAll() {
        try {
            document.getElementById("status-text").textContent = "正在导出...";
            var imageBlob = await PhotopeaBridge.exportImage();
            var maskBlob = null;
            try { maskBlob = await PhotopeaBridge.exportMask(); } catch (e) {}

            document.getElementById("status-text").textContent = "正在上传...";
            var imageResult = await this.uploadToComfyUI(imageBlob, "edited.png");

            var imageWidget = this.node.widgets && this.node.widgets.find(w => w.name === "image");
            if (imageWidget && imageResult.name) imageWidget.value = imageResult.name;

            if (maskBlob) {
                var maskResult = await this.uploadToComfyUI(maskBlob, "mask.png");
                var maskPathWidget = this.node.widgets && this.node.widgets.find(w => w.name === "mask_path");
                if (maskPathWidget && maskResult.name) maskPathWidget.value = maskResult.name;
            }

            this.node.setDirtyCanvas(true);
            document.getElementById("status-text").textContent = "已保存";
            setTimeout(() => this.close(), 500);
        } catch (e) {
            console.error("[InpaintRegionEditor] Save error:", e);
            alert("保存失败: " + e.message);
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
        if (this.escHandler) { document.removeEventListener("keydown", this.escHandler); this.escHandler = null; }
        this.modal && this.modal.remove();
        this.modal = null;
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
                callback: () => {
                    var imageWidget = node.widgets && node.widgets.find(w => w.name === "image");
                    var maskPathWidget = node.widgets && node.widgets.find(w => w.name === "mask_path");
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
            this.addWidget("STRING", "mask_path", "", () => {}, { serialize: true });
            this.addWidget("STRING", "mask_bounds", "{}", () => {}, { serialize: true });
            return result;
        };
    }
});

console.log("[InpaintRegionEditor] Extension loaded");
