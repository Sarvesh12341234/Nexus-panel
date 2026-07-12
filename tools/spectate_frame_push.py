#!/usr/bin/env python3
import argparse
import io
import signal
import sys
import time

try:
    import mss
    from PIL import Image
    import requests
except ImportError as error:
    missing = str(error).split("'")[1] if "'" in str(error) else str(error)
    print(f"Missing dependency: {missing}", file=sys.stderr)
    print("Install with: py -3 -m pip install mss pillow requests", file=sys.stderr)
    sys.exit(2)


running = True


def stop(_signum, _frame):
    global running
    running = False


def parse_region(value):
    if not value:
        return None
    parts = [int(part.strip()) for part in value.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("region must be left,top,width,height")
    left, top, width, height = parts
    if width < 16 or height < 16:
        raise argparse.ArgumentTypeError("region width and height must be at least 16")
    return {"left": left, "top": top, "width": width, "height": height}


def jpeg_bytes(frame, quality):
    image = Image.frombytes("RGB", frame.size, frame.rgb)
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=quality, optimize=True)
    return output.getvalue()


def main():
    parser = argparse.ArgumentParser(description="Push a real Minecraft client view into NexusPanel Live Spectate.")
    parser.add_argument("--url", required=True, help="NexusPanel frame-push URL, ending in /api/servers/<id>/spectate/frame-push")
    parser.add_argument("--token", required=True, help="Spectate frame push token from Settings")
    parser.add_argument("--fps", type=float, default=12.0, help="Target frames per second")
    parser.add_argument("--quality", type=int, default=72, help="JPEG quality from 35 to 95")
    parser.add_argument("--monitor", type=int, default=1, help="mss monitor number, usually 1")
    parser.add_argument("--region", type=parse_region, default=None, help="Optional capture box: left,top,width,height")
    parser.add_argument("--timeout", type=float, default=5.0, help="HTTP timeout seconds")
    args = parser.parse_args()

    quality = max(35, min(95, args.quality))
    frame_delay = 1.0 / max(1.0, min(60.0, args.fps))
    headers = {
        "Content-Type": "image/jpeg",
        "X-NexusPanel-Stream-Token": args.token,
        "User-Agent": "NexusPanel-SpectateFramePush/1.0",
    }

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    posted = 0
    last_report = time.time()
    with mss.mss() as capture:
        if args.region:
            target = args.region
        else:
            if args.monitor < 1 or args.monitor >= len(capture.monitors):
                raise SystemExit(f"Monitor {args.monitor} not found. Available monitors: 1-{len(capture.monitors) - 1}")
            target = capture.monitors[args.monitor]

        print(f"Pushing {target['width']}x{target['height']} frames to NexusPanel. Press Ctrl+C to stop.")
        while running:
            started = time.time()
            frame = capture.grab(target)
            body = jpeg_bytes(frame, quality)
            try:
                response = requests.post(args.url, params={"token": args.token}, data=body, headers=headers, timeout=args.timeout)
                if response.status_code >= 400:
                    print(f"Frame rejected: HTTP {response.status_code} {response.text[:180]}", file=sys.stderr)
                    time.sleep(1.0)
                    continue
                posted += 1
            except requests.RequestException as error:
                print(f"Push failed: {error}", file=sys.stderr)
                time.sleep(1.0)
                continue

            now = time.time()
            if now - last_report >= 5:
                print(f"Live frames sent: {posted}")
                last_report = now
            time.sleep(max(0.0, frame_delay - (time.time() - started)))

    print(f"Stopped. Total frames sent: {posted}")


if __name__ == "__main__":
    main()
