"""
InpaintRegionEditor Node

增强版遮罩编辑器，支持 Photopea 集成和可配置选区

概念说明：
- 遮罩 (Mask): 定义重绘区域，重绘完成后只在遮罩内合成新内容
- 选区 (Region): 定义参考区域，大模型重绘时参考这个区域内的原图内容

约束：选区必须 >= 遮罩
"""

import torch
import numpy as np
import folder_paths
from PIL import Image
import os
import json


class InpaintRegionEditor:
    """
    增强版遮罩编辑器，支持 Photopea 集成和可配置选区
    """
    
    # 预设尺寸映射
    PRESET_SIZES = {
        "512×512 (SD)": (512, 512),
        "768×768": (768, 768),
        "1024×1024 (SDXL)": (1024, 1024),
        "1280×1280": (1280, 1280),
        "1536×1536": (1536, 1536),
    }
    
    @classmethod
    def INPUT_TYPES(s):
        input_dir = folder_paths.get_input_directory()
        files = [f for f in os.listdir(input_dir) 
                 if os.path.isfile(os.path.join(input_dir, f))]
        files = folder_paths.filter_files_content_types(files, ["image"])
        
        return {
            "required": {
                # 图像输入
                "image": (sorted(files), {"image_upload": True}),
                
                # 选区尺寸预设
                "region_size": (
                    list(s.PRESET_SIZES.keys()) + ["Custom (自定义)"],
                    {"default": "512×512 (SD)"}
                ),
                
                # 自定义选区尺寸
                "region_width": ("INT", {
                    "default": 512, 
                    "min": 64, 
                    "max": 4096, 
                    "step": 64
                }),
                "region_height": ("INT", {
                    "default": 512, 
                    "min": 64, 
                    "max": 4096, 
                    "step": 64
                }),
            },
            "hidden": {
                # 遮罩边界信息（前端传递）
                "mask_bounds": "STRING",
            }
        }
    
    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "region_top", "region_left", "region_width", "region_height")
    FUNCTION = "process"
    CATEGORY = "image/inpaint"
    
    def process(self, image, region_size, region_width, region_height, 
                mask_bounds=None):
        """
        处理图像和遮罩，计算选区位置
        
        Args:
            image: 图像文件名
            region_size: 选区预设名称
            region_width: 自定义选区宽度
            region_height: 自定义选区高度
            mask_bounds: 遮罩边界 JSON 字符串
        """
        # 加载图像
        image_path = folder_paths.get_annotated_filepath(image)
        img = Image.open(image_path)
        
        img_width, img_height = img.size
        
        # 提取或创建遮罩
        if 'A' in img.getbands():
            mask = np.array(img.getchannel('A')).astype(np.float32) / 255.0
            mask = 1.0 - mask  # ComfyUI 遮罩约定
        else:
            mask = np.zeros((img_height, img_width), dtype=np.float32)
        
        # 解析遮罩边界
        mask_bounds_dict = None
        if mask_bounds:
            try:
                mask_bounds_dict = json.loads(mask_bounds)
            except:
                pass
        
        # 如果没有前端传递的遮罩边界，自动计算
        if not mask_bounds_dict:
            mask_bounds_dict = self._calculate_mask_bounds(mask)
        
        # 确定选区尺寸
        if region_size in self.PRESET_SIZES:
            r_width, r_height = self.PRESET_SIZES[region_size]
        else:
            r_width, r_height = region_width, region_height
        
        # 约束验证：选区必须 >= 遮罩
        mask_w = mask_bounds_dict.get('width', 0)
        mask_h = mask_bounds_dict.get('height', 0)
        
        if r_width < mask_w:
            r_width = int(mask_w)
        if r_height < mask_h:
            r_height = int(mask_h)
        
        # 计算选区位置（居中于遮罩）
        mask_x = mask_bounds_dict.get('x', 0)
        mask_y = mask_bounds_dict.get('y', 0)
        
        region_x = mask_x + mask_w / 2 - r_width / 2
        region_y = mask_y + mask_h / 2 - r_height / 2
        
        # 确保选区在图像范围内
        region_x = max(0, min(region_x, img_width - r_width))
        region_y = max(0, min(region_y, img_height - r_height))
        
        # 转换为 tensor
        image_tensor = torch.from_numpy(
            np.array(img.convert("RGB")).astype(np.float32) / 255.0
        ).unsqueeze(0)
        
        mask_tensor = torch.from_numpy(mask).unsqueeze(0)
        
        return (
            image_tensor, 
            mask_tensor, 
            int(region_y),  # top
            int(region_x),  # left
            int(r_width), 
            int(r_height)
        )
    
    def _calculate_mask_bounds(self, mask):
        """计算遮罩的边界框"""
        rows = np.any(mask > 0.5, axis=1)
        cols = np.any(mask > 0.5, axis=0)
        
        if not np.any(rows) or not np.any(cols):
            return {'x': 0, 'y': 0, 'width': 0, 'height': 0}
        
        rmin, rmax = np.where(rows)[0][[0, -1]]
        cmin, cmax = np.where(cols)[0][[0, -1]]
        
        return {
            'x': int(cmin),
            'y': int(rmin),
            'width': int(cmax - cmin + 1),
            'height': int(rmax - rmin + 1)
        }
