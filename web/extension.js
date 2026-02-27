/**
 * InpaintRegionEditor Extension
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
    },

    async postMessage(message) {
        var self = this;
        return new Promise(function(resolve, reject) {
            if (!self.photopeaWindow) {
                reject(new Error("Photopea not initialized"));
                return;
            }
            var responses = [];
            var timeoutId = null;
            var done = false;
            var handler = function(event) {
                if (event.origin !== self.PHOTOPEA_ORIGIN) return;
                responses.push(event.data);
                if (event.data === "done" && !done) {
                    done = true;
                    if (timeoutId) clearTimeout(timeoutId);
                    window.removeEventListener("message", handler);
                    resolve(responses);
                }
            };
            window.addEventListener("message", handler);
            self.photopeaWindow.postMessage(message, "*");
            timeoutId = setTimeout(function() {
                if (!done) {
                    done = true;
                    window.removeEventListener("message", handler);
                    reject(new Error("Timeout"));
                }
            }, 60000);
        });
    },

    async openImage(imageBlob) {
        var self = this;
        var reader = new FileReader();
        return new Promise(function(resolve, reject) {
            reader.onloadend = async function() {
                try {
                    await self.postMessage('app.open("' + reader.result + '", null, false);');
                    await self.postMessage('app.activeDocument.activeLayer.rasterize();');
                    resolve();
                } catch (e) { reject(e); }
            };
            reader.onerror = reject;
            reader.readAsDataURL(imageBlob);
        });
    },

    async exportImage() {
        var result = await this.postMessage('app.activeDocument.saveToOE("png");');
        for (var i = 0; i < result.length; i++) {
            if (result[i] instanceof ArrayBuffer) {
                return new Blob([result[i]], { type: "image/png" });
            }
        }
        throw new Error("Export failed");
    },

    async exportLayerMask() {
        console.log("[DEBUG] 开始导出图层蒙版");
        
        // 步骤1: 检查是否有图层蒙版
        console.log("[DEBUG] 步骤1: 检查图层蒙版...");
        var checkResult = await this.postMessage('app.echoToOE(app.activeLayer.mask ? "HAS_MASK" : "NO_MASK");');
        console.log("[DEBUG] 检查结果:", checkResult);
        
        var hasMask = false;
        for (var i = 0; i < checkResult.length; i++) {
            if (checkResult[i] === "HAS_MASK") { hasMask = true; break; }
            if (checkResult[i] === "NO_MASK") { console.log("[DEBUG] 没有图层蒙版"); return null; }
        }
        console.log("[DEBUG] 有图层蒙版:", hasMask);
        if (!hasMask) { console.log("[DEBUG] 未检测到蒙版"); return null; }
        
        // 步骤2: 检查蒙版是否启用
        console.log("[DEBUG] 步骤2: 检查蒙版是否启用...");
        var enabledResult = await this.postMessage('app.echoToOE(app.activeLayer.mask.enabled ? "ENABLED" : "DISABLED");');
        console.log("[DEBUG] 启用状态:", enabledResult);
        
        // 步骤3: 获取蒙版通道名称
        console.log("[DEBUG] 步骤3: 获取通道列表...");
        var channelsResult = await this.postMessage('app.echoToOE(JSON.stringify(app.activeDocument.channels.map(function(c){return c.name;})));');
        console.log("[DEBUG] 通道列表:", channelsResult);
        
        // 步骤4: 尝试简单的蒙版导出
        console.log("[DEBUG] 步骤4: 尝试导出蒙版...");
        
        var script = [
            '(function(){',
            '  try {',
            '    var d = app.activeDocument;',
            '    var l = d.activeLayer;',
            '    ',
            '    if (!l.mask) { app.echoToOE("ERR_NO_MASK_OBJ"); return; }',
            '    if (!l.mask.enabled) { app.echoToOE("ERR_MASK_DISABLED"); return; }',
            '    ',
            '    // 选择蒙版通道',
            '    d.activeChannels = [d.channels.getByName("Mask")];',
            '    ',
            '    // 全选复制',
            '    d.selection.selectAll();',
            '    d.selection.copy();',
            '    ',
            '    // 恢复 RGB 通道',
            '    d.activeChannels = d.componentChannels;',
            '    ',
            '    // 创建新文档',
            '    var newDoc = app.documents.add(d.width, d.height);',
            '    newDoc.paste();',
            '    newDoc.saveToOE("png");',
            '    newDoc.close(SaveOptions.DONOTSAVECHANGES);',
            '    ',
            '    app.echoToOE("MASK_EXPORTED");',
            '  } catch(e) {',
            '    app.echoToOE("ERR_" + e.message);',
            '  }',
            '})();'
        ].join('\n');
        
        console.log("[DEBUG] 执行脚本...");
        var result = await this.postMessage(script);
        console.log("[DEBUG] 脚本结果:", result);
        
        // 检查错误
        for (var i = 0; i < result.length; i++) {
            if (typeof result[i] === "string") {
                if (result[i].indexOf("ERR_") === 0) {
                    console.log("[DEBUG] 脚本错误:", result[i]);
                    return null;
                }
                if (result[i] === "MASK_EXPORTED") {
                    console.log("[DEBUG] 蒙版导出成功");
                }
            }
        }
        
        // 查找 ArrayBuffer
        for (var i = 0; i < result.length; i++) {
            if (result[i] instanceof ArrayBuffer) {
                console.log("[DEBUG] 找到图像数据，大小:", result[i].byteLength);
                return new Blob([result[i]], { type: "image/png" });
            }
        }
        
        console.log("[DEBUG] 未找到图像数据");
        return null;
    }
};

const PhotopeaModal = {
    modal: null,
    node: null,
    isOpen: false,

    show(node, imagePath) {
        this.node = node;
        this.imagePath = imagePath;
        this.isOpen = true;
        this.createUI();
    },

    createUI() {
        var self = this;
        this.modal && this.modal.remove();
        this.modal = document.createElement("div");
        this.modal.className = "photopea-modal";
        this.modal.innerHTML = "<div class='pp-container'><iframe id='pp-iframe' src='https://www.photopea.com/'></iframe><div class='pp-toolbar'><div class='pp-left'><span class='pp-hint'>图层>图层蒙版>显示全部，用画笔绘制蒙版</span></div><div class='pp-right'><button id='pp-save' class='pp-btn pp-save'>保存</button><button id='pp-cancel' class='pp-btn pp-cancel'>取消</button></div></div><div class='pp-status'><span id='pp-status'>加载中...</span></div></div>";
        this.injectStyles();
        document.body.appendChild(this.modal);
        var iframe = document.getElementById("pp-iframe");
        iframe.onload = async function() {
            if (!self.isOpen) return;
            PhotopeaBridge.init(iframe);
            self.setStatus("加载图像...");
            self.setupEvents();
            await self.loadImage();
        };
    },

    injectStyles() {
        if (document.getElementById("pp-styles")) return;
        var s = document.createElement("style");
        s.id = "pp-styles";
        s.textContent = ".photopea-modal{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.9);z-index:99999;display:flex;align-items:center;justify-content:center}.pp-container{width:95%;height:95%;display:flex;flex-direction:column;background:#1e1e1e;border-radius:8px;overflow:hidden}#pp-iframe{flex:1;width:100%;border:none}.pp-toolbar{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:#2d2d2d;border-top:1px solid #444;gap:10px}.pp-left{display:flex;align-items:center}.pp-right{display:flex;gap:10px}.pp-hint{color:#999;font-size:13px}.pp-btn{padding:10px 18px;border:none;border-radius:6px;cursor:pointer;font-size:14px}.pp-btn:hover{transform:translateY(-1px)}.pp-save{background:#107c10;color:#fff}.pp-cancel{background:#555;color:#fff}.pp-status{padding:8px 16px;background:#1a1a1a;color:#888;font-size:12px}";
        document.head.appendChild(s);
    },

    setStatus(t) { if (this.isOpen) { var el = document.getElementById("pp-status"); if (el) el.textContent = t; } },

    setupEvents() {
        var self = this;
        document.getElementById("pp-save").onclick = async function() { await self.saveAll(); };
        document.getElementById("pp-cancel").onclick = function() { self.close(); };
        this.escHandler = function(e) { if (e.key === "Escape") self.close(); };
        document.addEventListener("keydown", this.escHandler);
    },

    async loadImage() {
        try {
            var path = this.imagePath || "";
            var filename = path, type = "input", subfolder = "";
            var m = path.match(/^(.+?)\s*\[(\w+)\]$/);
            if (m) { filename = m[1].trim(); type = m[2]; }
            var idx = filename.lastIndexOf("/");
            if (idx !== -1) { subfolder = filename.substring(0, idx); filename = filename.substring(idx + 1); }
            var url = "/view?filename=" + encodeURIComponent(filename) + "&type=" + type;
            if (subfolder) url += "&subfolder=" + encodeURIComponent(subfolder);
            var resp = await fetch(url);
            if (!resp.ok) { this.setStatus("加载失败"); return; }
            await PhotopeaBridge.openImage(await resp.blob());
            this.setStatus("图像已加载。用 图层>图层蒙版>显示全部，画笔绘制");
        } catch (e) { this.setStatus("加载失败: " + e.message); }
    },

    async saveAll() {
        if (!this.isOpen) return;
        try {
            console.log("[SAVE] 开始保存...");
            this.setStatus("导出图像...");
            var imageBlob = await PhotopeaBridge.exportImage();
            console.log("[SAVE] 图像大小:", imageBlob.size);
            this.setStatus("检查蒙版...");
            console.log("[SAVE] 检查蒙版...");
            var maskBlob = await PhotopeaBridge.exportLayerMask();
            console.log("[SAVE] 蒙版结果:", maskBlob ? maskBlob.size : "无");
            this.setStatus("上传...");
            var imgResult = await this.upload(imageBlob, "edited.png");
            if (imgResult.name) { var w = this.node.widgets && this.node.widgets.find(function(x) { return x.name === "image"; }); if (w) w.value = imgResult.name; }
            if (maskBlob) {
                var maskResult = await this.upload(maskBlob, "mask.png");
                if (maskResult.name) { var mw = this.node.widgets && this.node.widgets.find(function(x) { return x.name === "mask_path"; }); if (mw) mw.value = maskResult.name; }
            }
            this.node.setDirtyCanvas(true);
            this.setStatus(maskBlob ? "已保存（含蒙版）" : "已保存（无蒙版）");
            var self = this;
            setTimeout(function() { self.close(); }, 500);
        } catch (e) { console.error("[SAVE] 错误:", e); this.setStatus("失败: " + e.message); alert("保存失败: " + e.message); }
    },

    async upload(blob, name) {
        var fd = new FormData();
        fd.append("image", blob, name);
        fd.append("type", "input");
        var resp = await api.fetchApi("/upload/image", { method: "POST", body: fd });
        return await resp.json();
    },

    close() {
        this.isOpen = false;
        if (this.escHandler) { document.removeEventListener("keydown", this.escHandler); this.escHandler = null; }
        if (this.modal) { this.modal.remove(); this.modal = null; }
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
            options.push({ content: "Open in Photopea", callback: function() {
                var w = node.widgets && node.widgets.find(function(x) { return x.name === "image"; });
                if (w && w.value) { PhotopeaModal.show(node, w.value); } else { alert("请先上传图像"); }
            }});
            return options;
        };
        var onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            var r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            this.addWidget("STRING", "mask_path", "", function() {}, { serialize: true });
            this.addWidget("STRING", "mask_bounds", "{}", function() {}, { serialize: true });
            return r;
        };
    }
});

console.log("[InpaintRegionEditor] Loaded");
