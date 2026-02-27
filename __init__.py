"""
@author: InpaintRegionEditor
@title: Inpaint Region Editor
@description: Enhanced mask editor with Photopea integration and configurable inpaint region
"""

from .nodes import InpaintRegionEditor

NODE_CLASS_MAPPINGS = {
    "InpaintRegionEditor": InpaintRegionEditor
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "InpaintRegionEditor": "Inpaint Region Editor"
}

WEB_DIRECTORY = "./web"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
