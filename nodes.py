"""
InpaintRegionEditor Node

增强版遮罩编辑器，支持 Photopea 集成和可拖动选区

概念说明：
- 遮罩 (Mask): 定义重绘区域，AI 在这个区域内生成新内容
- 选区 (Region): 定义参考区域，AI 参考这个区域内的原图内容

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
    增强版遮罩编辑器，支持 Photopea 集成和可拖动选区
    """

    @classmethod
    def INPUT_TYPES(s):
        input_dir = folder_paths.get_input_directory()
        files = [
            f
            for f in os.listdir(input_dir)
            if os.path.isfile(os.path.join(input_dir, f))
        ]
        files = folder_paths.filter_files_content_types(files, ["image"])

        return {
            "required": {
                "image": (sorted(files), {}),
                "padding": ("INT", {"default": 64, "min": 0, "max": 512, "step": 32}),
            },
            "hidden": {
                "region_coords": "STRING",
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT", "INT", "INT")
    RETURN_NAMES = (
        "image",
        "mask",
        "region_top",
        "region_left",
        "region_width",
        "region_height",
    )
    FUNCTION = "process"
    CATEGORY = "image/inpaint"

    def process(self, image, padding, region_coords=None):
        image_path = folder_paths.get_annotated_filepath(image)
        img = Image.open(image_path)

        img_width, img_height = img.size

        # 提取 MASK（从 Alpha 通道）
        if "A" in img.getbands():
            mask = np.array(img.getchannel("A")).astype(np.float32) / 255.0
            mask = 1.0 - mask  # ComfyUI 约定：1=遮罩区域
        else:
            raise ValueError(
                "请先创建蒙版（局部重绘需要蒙版）\n"
                "可以通过以下方式创建：\n"
                "1. 上传带 Alpha 通道的 PNG\n"
                "2. 使用 Photopea 编辑后保存\n"
                "3. 使用 ComfyUI 系统蒙版工具绘制"
            )

        # 计算蒙版边界框
        mask_bounds = self._calculate_mask_bounds(mask)

        # 解析前端坐标（如果用户拖动过）
        region_rect = None
        if region_coords:
            try:
                region_rect = json.loads(region_coords)
            except:
                pass

        if not region_rect:
            region_rect = self._calculate_region_rect(mask_bounds, padding)

        # 验证
        if (
            region_rect["width"] < mask_bounds["width"]
            or region_rect["height"] < mask_bounds["height"]
        ):
            raise ValueError(
                f"选区太小！必须 >= 遮罩\n"
                f"选区：{region_rect['width']}×{region_rect['height']}\n"
                f"遮罩：{mask_bounds['width']}×{mask_bounds['height']}"
            )

        region_rect = self._clamp_to_image(region_rect, img_width, img_height)

        # 转换为 tensor
        image_tensor = torch.from_numpy(
            np.array(img.convert("RGB")).astype(np.float32) / 255.0
        ).unsqueeze(0)

        mask_tensor = torch.from_numpy(mask).unsqueeze(0)

        return (
            image_tensor,
            mask_tensor,
            int(region_rect["y"]),
            int(region_rect["x"]),
            int(region_rect["width"]),
            int(region_rect["height"]),
        )

    def _calculate_mask_bounds(self, mask):
        rows = np.any(mask > 0.5, axis=1)
        cols = np.any(mask > 0.5, axis=0)

        if not np.any(rows) or not np.any(cols):
            return {"x": 0, "y": 0, "width": 0, "height": 0}

        rmin, rmax = np.where(rows)[0][[0, -1]]
        cmin, cmax = np.where(cols)[0][[0, -1]]

        return {
            "x": int(cmin),
            "y": int(rmin),
            "width": int(cmax - cmin + 1),
            "height": int(rmax - rmin + 1),
        }

    def _calculate_region_rect(self, mask_bounds, padding):
        return {
            "x": mask_bounds["x"] - padding,
            "y": mask_bounds["y"] - padding,
            "width": mask_bounds["width"] + padding * 2,
            "height": mask_bounds["height"] + padding * 2,
        }

    def _clamp_to_image(self, rect, img_width, img_height):
        x = max(0, min(rect["x"], img_width - rect["width"]))
        y = max(0, min(rect["y"], img_height - rect["height"]))
        return {"x": x, "y": y, "width": rect["width"], "height": rect["height"]}

    @classmethod
    def IS_CHANGED(s, image, padding, region_coords=None):
        return float("NaN")
