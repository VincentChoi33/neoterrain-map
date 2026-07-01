#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

PROMPTS = {
    "water": {
        "prompts": ["river", "water", "lake", "reservoir", "canal"],
        "max_area_frac": 0.65,
        "min_area": 64,
    },
    "stream": {
        "prompts": ["stream", "creek", "brook", "small river", "narrow water channel", "drainage ditch", "watercourse"],
        "max_area_frac": 0.22,
        "min_area": 24,
        "conf_offset": -0.1,
        "morph_open": False,
    },
    "road": {
        "prompts": ["road", "highway", "street", "paved road"],
        "max_area_frac": 0.35,
        "min_area": 48,
    },
    "mountain_road": {
        "prompts": ["mountain road", "forest road", "dirt road", "gravel road", "unpaved road", "track road"],
        "max_area_frac": 0.28,
        "min_area": 32,
        "conf_offset": -0.06,
    },
    "trail": {
        "prompts": ["trail", "footpath", "narrow path", "hiking trail"],
        "max_area_frac": 0.18,
        "min_area": 24,
        "conf_offset": -0.08,
    },
    "bridge": {
        "prompts": ["bridge", "road bridge", "small bridge", "culvert"],
        "max_area_frac": 0.12,
        "min_area": 24,
        "conf_offset": -0.05,
    },
    "forest": {
        "prompts": ["forest", "woods", "tree canopy", "dense vegetation"],
        "max_area_frac": 0.72,
        "min_area": 96,
        "conf_offset": -0.05,
    },
    "built": {
        "prompts": ["building", "house", "roof", "industrial building", "built structure"],
        "max_area_frac": 0.32,
        "min_area": 48,
        "conf_offset": -0.04,
    },
}

COLORS = {
    "water": (39, 121, 190),
    "stream": (70, 168, 218),
    "road": (215, 222, 228),
    "mountain_road": (196, 165, 92),
    "trail": (185, 122, 205),
    "bridge": (36, 192, 107),
    "forest": (45, 129, 83),
    "built": (151, 80, 89),
    "crossing": (240, 138, 62),
}


def tile_starts(length, tile_size, overlap):
    if tile_size <= 0 or tile_size >= length:
        return [0]
    stride = max(64, tile_size - overlap)
    starts = list(range(0, max(1, length - tile_size + 1), stride))
    last = length - tile_size
    if starts[-1] != last:
        starts.append(last)
    return sorted(set(starts))


def mask_bbox(mask):
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return None
    return [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]


def clean_mask(mask, min_area=32, morph_open=True, morph_close=True):
    mask_u8 = mask.astype(np.uint8) * 255
    kernel = np.ones((3, 3), np.uint8)
    if morph_open:
        mask_u8 = cv2.morphologyEx(mask_u8, cv2.MORPH_OPEN, kernel)
    if morph_close:
        mask_u8 = cv2.morphologyEx(mask_u8, cv2.MORPH_CLOSE, kernel)
    num, labels, stats, _ = cv2.connectedComponentsWithStats(mask_u8, connectivity=8)
    out = np.zeros_like(mask_u8)
    for label in range(1, num):
        if stats[label, cv2.CC_STAT_AREA] >= min_area:
            out[labels == label] = 255
    return out > 0


def derive_thin_water(water, min_area=40, max_width_px=34, min_elongation=2.6):
    mask_u8 = water.astype(np.uint8) * 255
    num, labels, stats, _ = cv2.connectedComponentsWithStats(mask_u8, connectivity=8)
    out = np.zeros_like(mask_u8)
    for label in range(1, num):
        area = stats[label, cv2.CC_STAT_AREA]
        if area < min_area:
            continue
        w = stats[label, cv2.CC_STAT_WIDTH]
        h = stats[label, cv2.CC_STAT_HEIGHT]
        short_side = min(w, h)
        long_side = max(w, h)
        if short_side <= max_width_px and long_side / max(1, short_side) >= min_elongation:
            out[labels == label] = 255
    return out > 0


def keep_thin_components(mask, min_area=28, max_width_px=54, min_elongation=2.2):
    mask_u8 = mask.astype(np.uint8) * 255
    num, labels, stats, _ = cv2.connectedComponentsWithStats(mask_u8, connectivity=8)
    out = np.zeros_like(mask_u8)
    for label in range(1, num):
        area = stats[label, cv2.CC_STAT_AREA]
        if area < min_area:
            continue
        w = stats[label, cv2.CC_STAT_WIDTH]
        h = stats[label, cv2.CC_STAT_HEIGHT]
        short_side = min(w, h)
        long_side = max(w, h)
        if short_side <= max_width_px and long_side / max(1, short_side) >= min_elongation:
            out[labels == label] = 255
    return out > 0


def derive_mountain_road_candidates(image, exclude_mask, min_area=36):
    arr = np.array(image.convert("RGB"))
    hsv = cv2.cvtColor(arr, cv2.COLOR_RGB2HSV)
    gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    hue = hsv[:, :, 0]

    bright_gray = (sat < 72) & (val > 118)
    pale_soil = (hue >= 10) & (hue <= 38) & (sat < 105) & (val > 104)
    top_hat = cv2.morphologyEx(
        gray,
        cv2.MORPH_TOPHAT,
        cv2.getStructuringElement(cv2.MORPH_RECT, (23, 23)),
    )
    seed = (bright_gray | pale_soil | (top_hat > 24))

    exclude = cv2.dilate(exclude_mask.astype(np.uint8) * 255, np.ones((7, 7), np.uint8)) > 0
    seed &= ~exclude
    seed_u8 = seed.astype(np.uint8) * 255
    seed_u8 = cv2.morphologyEx(seed_u8, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    seed_u8 = cv2.morphologyEx(seed_u8, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))

    num, labels, stats, _ = cv2.connectedComponentsWithStats(seed_u8, connectivity=8)
    out = np.zeros_like(seed_u8)
    components = []
    for label in range(1, num):
        area = stats[label, cv2.CC_STAT_AREA]
        if area < min_area or area > 6500:
            continue
        w = stats[label, cv2.CC_STAT_WIDTH]
        h = stats[label, cv2.CC_STAT_HEIGHT]
        short_side = min(w, h)
        long_side = max(w, h)
        fill = area / max(1, w * h)
        if short_side <= 42 and long_side / max(1, short_side) >= 2.4 and fill <= 0.62:
            out[labels == label] = 255
            components.append({
                "area_px": int(area),
                "bbox": [
                    int(stats[label, cv2.CC_STAT_LEFT]),
                    int(stats[label, cv2.CC_STAT_TOP]),
                    int(stats[label, cv2.CC_STAT_LEFT] + w),
                    int(stats[label, cv2.CC_STAT_TOP] + h),
                ],
            })
    return out > 0, components


def run_prompts(image, args):
    os.environ["CUDA_VISIBLE_DEVICES"] = str(args.gpu_id)
    import torch
    from sam3 import build_sam3_image_model
    from sam3.model.sam3_image_processor import Sam3Processor

    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    with torch.autocast("cuda", dtype=torch.bfloat16, enabled=device.type == "cuda"):
        model = build_sam3_image_model(
            checkpoint_path=args.checkpoint_path,
            load_from_HF=False,
            bpe_path=args.bpe_path,
        )
        model.to(device)
    processor = Sam3Processor(model, confidence_threshold=args.conf, device=device)

    classes = [cls.strip() for cls in args.classes.split(",") if cls.strip()]
    classes = [cls for cls in classes if cls in PROMPTS]
    masks_by_class = {
        cls: np.zeros((image.size[1], image.size[0]), dtype=bool)
        for cls in classes
    }
    detections = []
    width, height = image.size

    def run_window(window_image, classes, offset_x=0, offset_y=0, tile_id="full"):
        win_w, win_h = window_image.size
        with torch.autocast("cuda", dtype=torch.bfloat16, enabled=device.type == "cuda"):
            state = processor.set_image(window_image)
        for cls in classes:
            config = PROMPTS[cls]
            prompts = config["prompts"]
            min_area = max(1, int(config.get("min_area", args.min_area)))
            max_area = win_w * win_h * float(config.get("max_area_frac", args.max_area_frac))
            prompt_conf = max(0.05, args.conf + float(config.get("conf_offset", 0)))
            combined = np.zeros((win_h, win_w), dtype=bool)
            for prompt in prompts:
                with torch.autocast("cuda", dtype=torch.bfloat16, enabled=device.type == "cuda"):
                    state = processor.set_text_prompt(state=state, prompt=prompt)
                masks = state.get("pred_masks") or state.get("masks")
                if masks is None:
                    continue
                masks_np = masks.detach().cpu().numpy() > 0
                scores = state.get("pred_scores", [1.0] * len(masks_np))
                if isinstance(scores, torch.Tensor):
                    scores = scores.detach().cpu().numpy()
                for index, mask in enumerate(masks_np):
                    if mask.ndim == 3:
                        mask = mask.squeeze(0)
                    score = float(scores[index])
                    area = int(mask.sum())
                    if score < prompt_conf or area < min_area or area > max_area:
                        continue
                    cleaned = clean_mask(
                        mask,
                        min_area,
                        morph_open=bool(config.get("morph_open", True)),
                        morph_close=bool(config.get("morph_close", True)),
                    )
                    if cleaned.sum() < min_area:
                        continue
                    combined |= cleaned
                    bbox = mask_bbox(cleaned)
                    if bbox is not None:
                        bbox = [bbox[0] + offset_x, bbox[1] + offset_y, bbox[2] + offset_x, bbox[3] + offset_y]
                    detections.append({
                        "class": cls,
                        "prompt": prompt,
                        "score": score,
                        "area_px": int(cleaned.sum()),
                        "bbox": bbox,
                        "tile": tile_id,
                    })
            if combined.any():
                y1 = offset_y + win_h
                x1 = offset_x + win_w
                masks_by_class[cls][offset_y:y1, offset_x:x1] |= combined

    run_window(image, classes, 0, 0, "full")

    tile_classes = [cls.strip() for cls in args.tile_classes.split(",") if cls.strip()]
    tile_classes = [cls for cls in tile_classes if cls in PROMPTS]
    if args.tile_size > 0 and tile_classes:
        xs = tile_starts(width, args.tile_size, args.tile_overlap)
        ys = tile_starts(height, args.tile_size, args.tile_overlap)
        for y in ys:
            for x in xs:
                tile = image.crop((x, y, min(width, x + args.tile_size), min(height, y + args.tile_size)))
                run_window(tile, tile_classes, x, y, f"tile_{x}_{y}")

    water_for_refinement = masks_by_class.get("water", np.zeros((height, width), dtype=bool))
    if "stream" in masks_by_class:
        masks_by_class["stream"] = keep_thin_components(masks_by_class["stream"]) | derive_thin_water(water_for_refinement)
    if "mountain_road" in masks_by_class:
        heuristic_roads, road_components = derive_mountain_road_candidates(
            image,
            water_for_refinement | masks_by_class.get("stream", np.zeros((height, width), dtype=bool)),
        )
        masks_by_class["mountain_road"] = masks_by_class["mountain_road"] | heuristic_roads
        for component in road_components[:120]:
            detections.append({
                "class": "mountain_road",
                "prompt": "image_linear_refinement",
                "score": 0.62,
                **component,
            })
    return masks_by_class, detections


def dominant_linear_class(r_pct, m_pct, t_pct, b_pct):
    scores = {
        "road": r_pct,
        "mountain_road": m_pct,
        "trail": t_pct,
        "bridge": b_pct,
    }
    return max(scores.items(), key=lambda item: item[1])[0]


def road_width_for_class(cls):
    if cls == "bridge":
        return 6.5
    if cls == "road":
        return 5.5
    if cls == "mountain_road":
        return 3.1
    if cls == "trail":
        return 1.2
    return 3.0


def road_class_for_vision(cls, crossing_status):
    if crossing_status == "confirmed":
        return "sam3_bridge"
    if cls == "mountain_road":
        return "mountain_road"
    if cls == "trail":
        return "path"
    return "image_road"


def build_grid(masks, meta, args, image_size):
    width, height = image_size
    grid_n = args.grid_n
    cell_m = args.cell_m
    water = masks.get("water", np.zeros((height, width), dtype=bool))
    stream = masks.get("stream", np.zeros((height, width), dtype=bool))
    water = water | stream
    road = masks.get("road", np.zeros((height, width), dtype=bool))
    mountain_road = masks.get("mountain_road", np.zeros((height, width), dtype=bool))
    trail = masks.get("trail", np.zeros((height, width), dtype=bool))
    bridge = masks.get("bridge", np.zeros((height, width), dtype=bool))
    forest = masks.get("forest", np.zeros((height, width), dtype=bool))
    built = masks.get("built", np.zeros((height, width), dtype=bool))
    linear = road | mountain_road | trail | bridge
    crossing = (water & linear) | bridge

    records = []
    for j in range(grid_n):
        y0 = int(round(j * height / grid_n))
        y1 = int(round((j + 1) * height / grid_n))
        for i in range(grid_n):
            x0 = int(round(i * width / grid_n))
            x1 = int(round((i + 1) * width / grid_n))
            area = max(1, (y1 - y0) * (x1 - x0))
            w_pct = float(water[y0:y1, x0:x1].sum()) / area
            s_pct = float(stream[y0:y1, x0:x1].sum()) / area
            r_pct = float(road[y0:y1, x0:x1].sum()) / area
            m_pct = float(mountain_road[y0:y1, x0:x1].sum()) / area
            t_pct = float(trail[y0:y1, x0:x1].sum()) / area
            b_pct = float(bridge[y0:y1, x0:x1].sum()) / area
            f_pct = float(forest[y0:y1, x0:x1].sum()) / area
            u_pct = float(built[y0:y1, x0:x1].sum()) / area
            c_pct = float(crossing[y0:y1, x0:x1].sum()) / area
            if max(w_pct, s_pct, r_pct, m_pct, t_pct, b_pct, f_pct, u_pct, c_pct) < 0.08:
                continue
            if b_pct >= 0.08:
                primary = "road"
                road_kind = "bridge"
                confidence = min(0.94, 0.72 + b_pct * 0.25)
                crossing_status = "confirmed"
            elif c_pct >= 0.08:
                road_kind = dominant_linear_class(r_pct, m_pct, t_pct, b_pct)
                primary = road_kind if road_kind != "bridge" else "road"
                confidence = min(0.88, 0.58 + c_pct * 0.3)
                crossing_status = "candidate"
            elif s_pct >= 0.1 and s_pct >= r_pct * 1.15 and s_pct >= m_pct * 1.15:
                primary = "stream"
                road_kind = None
                confidence = min(0.9, 0.58 + s_pct * 0.36)
                crossing_status = "none"
            elif w_pct >= max(0.18, r_pct * 1.25):
                primary = "water"
                road_kind = None
                confidence = min(0.92, 0.55 + w_pct * 0.35)
                crossing_status = "none"
            elif m_pct >= 0.11:
                primary = "mountain_road"
                road_kind = "mountain_road"
                confidence = min(0.88, 0.52 + m_pct * 0.34)
                crossing_status = "none"
            elif t_pct >= 0.1:
                primary = "trail"
                road_kind = "trail"
                confidence = min(0.84, 0.5 + t_pct * 0.32)
                crossing_status = "none"
            elif r_pct >= 0.14:
                primary = "road"
                road_kind = "road"
                confidence = min(0.9, 0.52 + r_pct * 0.3)
                crossing_status = "none"
            elif u_pct >= 0.18:
                primary = "built"
                road_kind = None
                confidence = min(0.88, 0.5 + u_pct * 0.32)
                crossing_status = "none"
            elif f_pct >= 0.34:
                primary = "trees"
                road_kind = None
                confidence = min(0.88, 0.5 + f_pct * 0.32)
                crossing_status = "none"
            else:
                continue
            is_road = primary in {"road", "mountain_road", "trail"}
            is_water = primary in {"water", "stream"}
            road_width = road_width_for_class(road_kind) if is_road else 0
            road_class = road_class_for_vision(road_kind, crossing_status) if is_road else None
            primary_pct = {
                "water": w_pct,
                "stream": s_pct,
                "road": r_pct,
                "mountain_road": m_pct,
                "trail": t_pct,
                "trees": f_pct,
                "built": u_pct,
            }.get(primary, max(w_pct, s_pct, r_pct, m_pct, t_pct, b_pct, f_pct, u_pct, c_pct))
            secondary = "stream" if primary == "water" and s_pct > 0.06 else "water" if is_road and (w_pct > 0.05 or c_pct > 0.05) else "built" if primary != "built" and u_pct > 0.16 else "trees" if primary != "trees" and f_pct > 0.18 else "bare"
            secondary_pct = s_pct if secondary == "stream" else w_pct if secondary == "water" else u_pct if secondary == "built" else f_pct if secondary == "trees" else 0
            records.append({
                "i": i,
                "j": j,
                "visionClass": primary,
                "visionSecondary": secondary,
                "visionConfidence": round(confidence, 3),
                "visionPrimaryPct": int(round(primary_pct * 100)),
                "visionSecondaryPct": int(round(secondary_pct * 100)),
                "visionUnknownPct": max(0, 100 - int(round(max(w_pct, s_pct, r_pct, m_pct, t_pct, b_pct, f_pct, c_pct) * 100))),
                "water": is_water,
                "stream": primary == "stream",
                "road": is_road,
                "roadClass": road_class,
                "roadWidthM": road_width,
                "mountainRoad": primary == "mountain_road",
                "trail": primary == "trail",
                "forest": primary == "trees",
                "built": primary == "built",
                "building": primary == "built",
                "waterCrossing": crossing_status != "none",
                "crossingStatus": crossing_status,
                "source": "sam3_1_segmentation",
            })
    crossings = cluster_crossings(records, grid_n)
    return {
        "meta": {
            **meta,
            "source": "SAM3.1 text-prompt segmentation",
            "grid": {"n": grid_n, "cellM": cell_m},
            "thresholds": {
                "conf": args.conf,
                "tileSize": args.tile_size,
                "tileOverlap": args.tile_overlap,
                "tileClasses": args.tile_classes,
                "waterPct": 0.18,
                "streamPct": 0.1,
                "roadPct": 0.14,
                "mountainRoadPct": 0.11,
                "trailPct": 0.1,
                "builtPct": 0.18,
                "forestPct": 0.34,
                "crossingPct": 0.08,
            },
        },
        "cells": records,
        "crossings": crossings,
        "stats": {
            "cells": len(records),
            "waterCells": sum(1 for r in records if r["water"]),
            "streamCells": sum(1 for r in records if r.get("stream")),
            "roadCells": sum(1 for r in records if r["road"]),
            "mountainRoadCells": sum(1 for r in records if r.get("mountainRoad")),
            "trailCells": sum(1 for r in records if r.get("trail")),
            "forestCells": sum(1 for r in records if r.get("forest")),
            "buildingCells": sum(1 for r in records if r.get("building")),
            "crossingCells": sum(1 for r in records if r["waterCrossing"]),
            "crossings": len(crossings),
        },
    }


def cluster_crossings(records, grid_n):
    crossing_cells = {(r["i"], r["j"]): r for r in records if r["waterCrossing"]}
    visited = set()
    clusters = []
    dirs = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)]
    for key, record in crossing_cells.items():
        if key in visited:
            continue
        stack = [key]
        visited.add(key)
        members = []
        status = "candidate"
        while stack:
            i, j = stack.pop()
            rec = crossing_cells[(i, j)]
            members.append(rec)
            if rec.get("crossingStatus") == "confirmed":
                status = "confirmed"
            for di, dj in dirs:
                nxt = (i + di, j + dj)
                if nxt in crossing_cells and nxt not in visited:
                    visited.add(nxt)
                    stack.append(nxt)
        clusters.append({
            "i": round(sum(m["i"] for m in members) / len(members)),
            "j": round(sum(m["j"] for m in members) / len(members)),
            "count": len(members),
            "status": status,
            "source": "sam3_1_road_water_overlap",
        })
    return sorted(clusters, key=lambda c: c["count"], reverse=True)[:80]


def draw_overlay(image, masks, grid_data, out_path):
    base = image.convert("RGBA")
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    arr = np.array(overlay)
    for cls in ["water", "stream", "forest", "built", "road", "mountain_road", "trail", "bridge"]:
        mask = masks.get(cls)
        if mask is None:
            continue
        color = COLORS[cls]
        alpha = 95 if cls not in {"road", "mountain_road", "trail"} else 72
        arr[mask] = [color[0], color[1], color[2], alpha]
    overlay = Image.fromarray(arr, "RGBA")
    out = Image.alpha_composite(base, overlay)
    draw = ImageDraw.Draw(out)
    try:
        font = ImageFont.truetype("DejaVuSans.ttf", 18)
    except Exception:
        font = None
    width, height = image.size
    grid_n = grid_data["meta"]["grid"]["n"]
    for crossing in grid_data["crossings"]:
        x = (crossing["i"] + 0.5) * width / grid_n
        y = (crossing["j"] + 0.5) * height / grid_n
        color = COLORS["bridge"] if crossing["status"] == "confirmed" else COLORS["crossing"]
        draw.ellipse((x - 8, y - 8, x + 8, y + 8), fill=(*color, 235), outline=(255, 255, 255, 255), width=2)
    stats = grid_data["stats"]
    draw.rectangle((0, 0, 980, 36), fill=(0, 0, 0, 190))
    draw.text(
        (10, 7),
        f"SAM3.1 masks · water {stats['waterCells']} stream {stats['streamCells']} building {stats['buildingCells']} mountain-road {stats['mountainRoadCells']} crossing {stats['crossings']}",
        fill=(255, 255, 255, 255),
        font=font,
    )
    out.convert("RGB").save(out_path, quality=92)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--meta", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--checkpoint-path", default="/data/choihy/Lidar-Recon/tmp_sam31_ckpt/sam3.1_multiplex.pt")
    parser.add_argument("--bpe-path", default="/data/choihy/Lidar-Recon/sam3/sam3/assets/bpe_simple_vocab_16e6.txt.gz")
    parser.add_argument("--gpu-id", default="0")
    parser.add_argument("--conf", type=float, default=0.35)
    parser.add_argument("--classes", default="water,stream,built,forest")
    parser.add_argument("--min-area", type=int, default=64)
    parser.add_argument("--max-area-frac", type=float, default=0.65)
    parser.add_argument("--grid-n", type=int, default=500)
    parser.add_argument("--cell-m", type=int, default=10)
    parser.add_argument("--tile-size", type=int, default=768)
    parser.add_argument("--tile-overlap", type=int, default=192)
    parser.add_argument("--tile-classes", default="water,stream,built,forest")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    image = Image.open(args.image).convert("RGB")
    meta = json.loads(Path(args.meta).read_text(encoding="utf-8"))
    masks, detections = run_prompts(image, args)
    grid_data = build_grid(masks, meta, args, image.size)
    grid_data["detections"] = detections

    (output_dir / "segmentation_grid.json").write_text(json.dumps(grid_data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (output_dir / "sam3_detections.json").write_text(json.dumps(detections, ensure_ascii=False, indent=2), encoding="utf-8")
    draw_overlay(image, masks, grid_data, output_dir / "sam3_overlay.jpg")
    print(json.dumps({"output": str(output_dir), "stats": grid_data["stats"], "detections": len(detections)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
