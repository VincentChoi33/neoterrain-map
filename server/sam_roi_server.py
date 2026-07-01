#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

SCRIPT_DIR = Path(__file__).resolve().parent
EXPORT_SCRIPT = Path(os.environ.get("AOI_EXPORT_SCRIPT", SCRIPT_DIR / "export_aoi_tiles.py")).expanduser().resolve()
SAM_SCRIPT = Path(os.environ.get("SAM3_PASSABILITY_SCRIPT", SCRIPT_DIR / "run_sam3_passability.py")).expanduser().resolve()
DEFAULT_JOB_ROOT = SCRIPT_DIR / "server_jobs"
DEFAULT_ENV_FILE = SCRIPT_DIR.parent / ".env"


def response_json(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, ngrok-skip-browser-warning")
    handler.end_headers()
    handler.wfile.write(body)


def load_env_file(path):
    env_path = Path(path).expanduser()
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def tail_text(path, max_chars=4000):
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return ""
    return text[-max_chars:]


class JobStore:
    def __init__(self, root, python_bin, max_workers):
        self.root = Path(root)
        self.python_bin = python_bin
        self.root.mkdir(parents=True, exist_ok=True)
        self.executor = ThreadPoolExecutor(max_workers=max_workers)
        self.lock = threading.Lock()
        self.jobs = {}

    def create(self, payload):
        job_id = f"{int(time.time())}-{uuid.uuid4().hex[:8]}"
        job_dir = self.root / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        state = {
            "id": job_id,
            "status": "queued",
            "createdAt": time.time(),
            "updatedAt": time.time(),
            "message": "queued",
            "dir": str(job_dir),
            "stats": None,
        }
        with self.lock:
            self.jobs[job_id] = state
        (job_dir / "request.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        self.executor.submit(self._run, job_id, payload, job_dir)
        return state

    def get(self, job_id):
        with self.lock:
            return dict(self.jobs.get(job_id) or {})

    def update(self, job_id, **values):
        with self.lock:
            state = self.jobs[job_id]
            state.update(values)
            state["updatedAt"] = time.time()
            return dict(state)

    def _run(self, job_id, payload, job_dir):
        log_path = job_dir / "job.log"
        try:
            center = payload.get("center") or {}
            meters = payload.get("meters") or {}
            grid = payload.get("grid") or {}
            image = payload.get("image") or {}

            center_lat = float(center["lat"])
            center_lng = float(center["lng"])
            grid_n = int(grid.get("n") or 500)
            cell_m = int(grid.get("cellM") or grid.get("cell_m") or 10)
            width_m = float(meters.get("width") or grid_n * cell_m)
            height_m = float(meters.get("height") or grid_n * cell_m)
            zoom = int(image.get("zoom") or 16)
            size = int(image.get("size") or 1536)

            self.update(job_id, status="running", message="exporting satellite ROI")
            export_dir = job_dir / "tiles"
            export_cmd = [
                self.python_bin,
                str(EXPORT_SCRIPT),
                "--out-dir",
                str(export_dir),
                "--center-lat",
                str(center_lat),
                "--center-lng",
                str(center_lng),
                "--width-m",
                str(width_m),
                "--height-m",
                str(height_m),
                "--zoom",
                str(zoom),
                "--size",
                str(size),
            ]
            self._run_command(export_cmd, log_path)

            self.update(job_id, status="running", message="running SAM3.1 no-go masks")
            sam_dir = job_dir / "sam3"
            sam_cmd = [
                os.environ.get("SAM3_PYTHON", self.python_bin),
                str(SAM_SCRIPT),
                "--image",
                str(export_dir / "aoi_satellite.jpg"),
                "--meta",
                str(export_dir / "aoi_meta.json"),
                "--output-dir",
                str(sam_dir),
                "--grid-n",
                str(grid_n),
                "--cell-m",
                str(cell_m),
            ]
            if os.environ.get("SAM3_CHECKPOINT_PATH"):
                sam_cmd.extend(["--checkpoint-path", os.environ["SAM3_CHECKPOINT_PATH"]])
            if os.environ.get("SAM3_BPE_PATH"):
                sam_cmd.extend(["--bpe-path", os.environ["SAM3_BPE_PATH"]])
            if os.environ.get("SAM3_GPU_ID"):
                sam_cmd.extend(["--gpu-id", os.environ["SAM3_GPU_ID"]])
            if os.environ.get("SAM3_CLASSES"):
                sam_cmd.extend(["--classes", os.environ["SAM3_CLASSES"]])
            if os.environ.get("SAM3_TILE_CLASSES"):
                sam_cmd.extend(["--tile-classes", os.environ["SAM3_TILE_CLASSES"]])
            self._run_command(sam_cmd, log_path)

            result_path = sam_dir / "segmentation_grid.json"
            result = json.loads(result_path.read_text(encoding="utf-8"))
            self.update(job_id, status="completed", message="completed", stats=result.get("stats"))
        except Exception as exc:
            with log_path.open("a", encoding="utf-8") as log:
                log.write(f"\nERROR: {exc}\n")
            self.update(job_id, status="failed", message=str(exc))

    def _run_command(self, cmd, log_path):
        with log_path.open("a", encoding="utf-8") as log:
            log.write("\n$ " + " ".join(cmd) + "\n")
            log.flush()
            subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT, check=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "NeoTerrainSAM/0.1"

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, ngrok-skip-browser-warning")
        self.end_headers()

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/")
        if path != "/sam/roi":
            response_json(self, 404, {"error": "not_found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            if "center" not in payload:
                raise ValueError("center is required")
            job = self.server.job_store.create(payload)
            response_json(self, 202, self._job_payload(job))
        except Exception as exc:
            response_json(self, 400, {"status": "failed", "message": str(exc)})

    def do_GET(self):
        path = urlparse(self.path).path.rstrip("/")
        if path == "/healthz":
            response_json(self, 200, {"status": "ok"})
            return

        parts = [part for part in path.split("/") if part]
        if len(parts) >= 3 and parts[0] == "sam" and parts[1] == "jobs":
            job_id = parts[2]
            job = self.server.job_store.get(job_id)
            if not job:
                response_json(self, 404, {"error": "job_not_found"})
                return
            if len(parts) == 4 and parts[3] == "segmentation_grid.json":
                result_path = Path(job["dir"]) / "sam3" / "segmentation_grid.json"
                if job.get("status") != "completed" or not result_path.exists():
                    response_json(self, 409, {"status": job.get("status"), "message": job.get("message")})
                    return
                response_json(self, 200, json.loads(result_path.read_text(encoding="utf-8")))
                return
            response_json(self, 200, self._job_payload(job))
            return

        response_json(self, 404, {"error": "not_found"})

    def _job_payload(self, job):
        payload = {
            "jobId": job["id"],
            "status": job["status"],
            "message": job.get("message"),
            "statusUrl": f"/sam/jobs/{job['id']}",
        }
        if job.get("status") == "completed":
            payload["resultUrl"] = f"/sam/jobs/{job['id']}/segmentation_grid.json"
            payload["stats"] = job.get("stats")
        if job.get("status") == "failed":
            payload["logTail"] = tail_text(Path(job["dir"]) / "job.log")
        return payload

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--job-root", default=str(DEFAULT_JOB_ROOT))
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--max-workers", type=int, default=1)
    parser.add_argument("--env-file", default=str(DEFAULT_ENV_FILE))
    args = parser.parse_args()

    if args.env_file:
        load_env_file(args.env_file)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.job_store = JobStore(args.job_root, args.python, args.max_workers)
    print(f"SAM ROI API listening on http://{args.host}:{args.port}/sam/roi", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
