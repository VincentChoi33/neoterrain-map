#!/usr/bin/env python3
import argparse
import json
import math
from io import BytesIO
from pathlib import Path
from urllib.request import Request, urlopen

from PIL import Image

EARTH_RADIUS_M = 6378137.0
DEFAULT_CENTER = (37.7338, 127.4232)


def latlng_to_world(lat, lng, zoom):
    sin_lat = math.sin(math.radians(lat))
    n = 2 ** zoom
    x = (lng + 180.0) / 360.0 * n * 256
    y = (0.5 - math.log((1 + sin_lat) / (1 - sin_lat)) / (4 * math.pi)) * n * 256
    return x, y


def world_to_latlng(x, y, zoom):
    n = 2 ** zoom
    lng = x / (n * 256) * 360.0 - 180.0
    z = math.pi * (1 - 2 * y / (n * 256))
    lat = math.degrees(math.atan(math.sinh(z)))
    return lat, lng


def fetch_tile(z, x, y):
    url = f"https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
    req = Request(url, headers={"User-Agent": "passability-sam-mvp/1.0"})
    with urlopen(req, timeout=20) as response:
        return Image.open(BytesIO(response.read())).convert("RGB")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", default="work/sam_passability/outputs")
    parser.add_argument("--center-lat", type=float, default=DEFAULT_CENTER[0])
    parser.add_argument("--center-lng", type=float, default=DEFAULT_CENTER[1])
    parser.add_argument("--width-m", type=float, default=5000)
    parser.add_argument("--height-m", type=float, default=5000)
    parser.add_argument("--zoom", type=int, default=16)
    parser.add_argument("--size", type=int, default=1536)
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    center_x, center_y = latlng_to_world(args.center_lat, args.center_lng, args.zoom)
    meters_per_px = math.cos(math.radians(args.center_lat)) * 2 * math.pi * EARTH_RADIUS_M / (256 * 2 ** args.zoom)
    src_w_px = args.width_m / meters_per_px
    src_h_px = args.height_m / meters_per_px
    min_x = center_x - src_w_px / 2
    max_x = center_x + src_w_px / 2
    min_y = center_y - src_h_px / 2
    max_y = center_y + src_h_px / 2

    min_tx = math.floor(min_x / 256)
    max_tx = math.floor((max_x - 1) / 256)
    min_ty = math.floor(min_y / 256)
    max_ty = math.floor((max_y - 1) / 256)
    mosaic = Image.new("RGB", ((max_tx - min_tx + 1) * 256, (max_ty - min_ty + 1) * 256))
    for ty in range(min_ty, max_ty + 1):
        for tx in range(min_tx, max_tx + 1):
            tile = fetch_tile(args.zoom, tx, ty)
            mosaic.paste(tile, ((tx - min_tx) * 256, (ty - min_ty) * 256))

    crop_box = (
        int(round(min_x - min_tx * 256)),
        int(round(min_y - min_ty * 256)),
        int(round(max_x - min_tx * 256)),
        int(round(max_y - min_ty * 256)),
    )
    crop = mosaic.crop(crop_box)
    image = crop.resize((args.size, args.size), Image.Resampling.LANCZOS)

    north, west = world_to_latlng(min_x, min_y, args.zoom)
    south, east = world_to_latlng(max_x, max_y, args.zoom)
    meta = {
        "center": {"lat": args.center_lat, "lng": args.center_lng},
        "bbox": {"north": north, "south": south, "west": west, "east": east},
        "meters": {"width": args.width_m, "height": args.height_m},
        "image": {"width": args.size, "height": args.size, "zoom": args.zoom, "source": "Esri World Imagery"},
    }

    image_path = out_dir / "aoi_satellite.jpg"
    meta_path = out_dir / "aoi_meta.json"
    image.save(image_path, quality=92)
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"image": str(image_path), "meta": str(meta_path), **meta}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
