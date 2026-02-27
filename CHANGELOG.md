# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial implementation of InpaintRegionEditor node
- Photopea iframe integration for image editing
- Right-click menu "Open in Photopea" on node
- Load image + mask to Photopea (mask as layer mask)
- Export image + mask from Photopea
- Region size presets (512×512, 1024×1024, etc.)
- PostMessage API with origin verification for security

### Technical Details
- Backend: Python node with image upload and region presets
- Frontend: Photopea iframe with postMessage communication
- Security: Origin-verified messages (only from photopea.com)

### Known Issues
- Layer mask export script needs real-world testing
- Large images may have performance issues
- First Photopea load requires internet (~10MB)

## [0.1.0] - 2026-02-27

### Added
- Initial release
- Basic Photopea integration
- Mask loading/saving functionality

