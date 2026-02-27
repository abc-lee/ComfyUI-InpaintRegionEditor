# ComfyUI Inpaint Region Editor

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![ComfyUI](https://img.shields.io/badge/ComfyUI-Custom%20Node-blue.svg)](https://github.com/comfyanonymous/ComfyUI)

A ComfyUI custom node that integrates [Photopea](https://www.photopea.com/) (a free online Photoshop alternative) for advanced inpaint editing with mask support.

## Features

- 🎨 **Full Photopea Integration** - Complete Photoshop-like editing capabilities
- 📐 **Region Presets** - Pre-configured sizes for SD (512×512), SDXL (1024×1024)
- 🔄 **Bidirectional Sync** - Loads and saves both images and masks
- 🎭 **Layer Mask Support** - Masks are loaded as Photopea layer masks

## Installation

### Method 1: ComfyUI Manager (Recommended)
Search for "Inpaint Region Editor" in ComfyUI Manager.

### Method 2: Manual Installation
```bash
cd ComfyUI/custom_nodes
git clone https://github.com/YOUR_USERNAME/ComfyUI-InpaintRegionEditor.git
```

Restart ComfyUI.

## Usage

1. Add the **Inpaint Region Editor** node
2. Upload an image
3. Right-click the node → **"Open in Photopea"**
4. Edit your image and create/edit the mask
5. Click **"Save Image and Mask"**

## Node Outputs

| Output | Type | Description |
|--------|------|-------------|
| `image` | IMAGE | Edited image |
| `mask` | MASK | Inpaint mask |
| `region_top` | INT | Region top coordinate |
| `region_left` | INT | Region left coordinate |
| `region_width` | INT | Region width |
| `region_height` | INT | Region height |

## Concept: Mask vs Region

| Concept | Purpose |
|---------|---------|
| **Mask** | Define inpaint area (what to repaint) |
| **Region** | Define reference area (AI context) |

**Constraint**: Region size must be ≥ mask size.

## Technical Details

- Uses Photopea [postMessage API](https://www.photopea.com/api/)
- All message origins are verified for security
- Images processed locally in browser

## Limitations

- Requires internet (Photopea loaded from CDN)
- First load ~10MB, then cached

## Acknowledgments

- [Photopea](https://www.photopea.com/) by Ivan Kutskir
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI)

## License

MIT License - see [LICENSE](LICENSE) file.

### Photopea Usage
- Free API for any purpose (including commercial)
- Your work belongs entirely to you
- No attribution required (but appreciated)

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for details.
