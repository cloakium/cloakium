#!/usr/bin/env python3
"""Download a Cloakium release binary for the current platform.

Uses only Python stdlib — no pip dependencies required.

Usage:
    python3 scripts/download.py                     # latest, auto-detect platform
    python3 scripts/download.py --version 136.0.7103.113
    python3 scripts/download.py --dest /opt/cloakium
"""
import argparse
import json
import os
import platform
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

REPO = "cloakium/cloakium"
API_BASE = f"https://api.github.com/repos/{REPO}/releases"


def detect_platform():
    s = platform.system()
    m = platform.machine()
    if s == "Linux" and m == "x86_64":
        return "linux-amd64"
    if s == "Darwin" and m == "arm64":
        return "darwin-arm64"
    sys.exit(f"Unsupported platform: {s}-{m}")


def get_release(version=None):
    if version:
        url = f"{API_BASE}/tags/{version}"
    else:
        url = f"{API_BASE}/latest"
    req = urllib.request.Request(url)
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        req.add_header("Authorization", f"token {token}")
    req.add_header("Accept", "application/vnd.github+json")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            label = f"version {version}" if version else "latest"
            sys.exit(f"Release not found: {label}")
        raise


def find_asset(release, plat):
    expected = {
        "linux-amd64": "cloakium-linux-amd64.tar.zst",
        "darwin-arm64": "cloakium-darwin-arm64.zip",
    }
    name = expected[plat]
    for asset in release.get("assets", []):
        if asset["name"] == name:
            return asset
    sys.exit(f"Asset {name} not found in release {release['tag_name']}")


def download_file(url, dest_path):
    req = urllib.request.Request(url)
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        req.add_header("Authorization", f"token {token}")
    req.add_header("Accept", "application/octet-stream")
    with urllib.request.urlopen(req) as resp:
        total = int(resp.headers.get("Content-Length", 0))
        downloaded = 0
        with open(dest_path, "wb") as f:
            while True:
                chunk = resp.read(1 << 20)  # 1 MB
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)
                if total:
                    pct = downloaded * 100 // total
                    mb = downloaded / (1 << 20)
                    print(f"\r  {mb:.1f} MB ({pct}%)", end="", flush=True)
        if total:
            print()


def extract(archive_path, dest, plat):
    if plat == "linux-amd64":
        # .tar.zst — shell out to tar + zstd
        subprocess.run(
            ["tar", "--zstd", "-xf", archive_path, "-C", dest],
            check=True,
        )
    elif plat == "darwin-arm64":
        # .zip
        with zipfile.ZipFile(archive_path) as zf:
            zf.extractall(dest)
    else:
        sys.exit(f"Don't know how to extract for {plat}")


def find_binary(dest, plat):
    if plat == "linux-amd64":
        p = os.path.join(dest, "chrome")
        if os.path.isfile(p):
            os.chmod(p, 0o755)
            return p
    elif plat == "darwin-arm64":
        p = os.path.join(dest, "Chromium.app", "Contents", "MacOS", "Chromium")
        if os.path.isfile(p):
            return p
    # fallback: search
    for root, dirs, files in os.walk(dest):
        for f in files:
            if f in ("chrome", "Chromium"):
                return os.path.join(root, f)
    return None


def main():
    parser = argparse.ArgumentParser(description="Download Cloakium release binary")
    parser.add_argument("--version", help="Release version tag (default: latest)")
    parser.add_argument("--dest", default="./cloakium-bin", help="Destination directory")
    parser.add_argument("--platform", help="Override platform (linux-amd64, darwin-arm64)")
    args = parser.parse_args()

    plat = args.platform or detect_platform()
    dest = os.path.abspath(args.dest)
    os.makedirs(dest, exist_ok=True)

    print(f"Platform: {plat}")
    release = get_release(args.version)
    tag = release["tag_name"]
    print(f"Release:  {tag}")

    asset = find_asset(release, plat)
    print(f"Asset:    {asset['name']} ({asset['size'] / (1 << 20):.1f} MB)")

    with tempfile.NamedTemporaryFile(suffix=os.path.splitext(asset["name"])[1], delete=False) as tmp:
        tmp_path = tmp.name

    try:
        print(f"Downloading...")
        download_file(asset["browser_download_url"], tmp_path)
        print(f"Extracting to {dest}...")
        extract(tmp_path, dest, plat)
    finally:
        os.unlink(tmp_path)

    binary = find_binary(dest, plat)
    if binary:
        print(f"Binary:   {binary}")
    else:
        print(f"Extracted to {dest} (binary not found automatically)")
    # Last line is the binary path for scripting
    print(binary or dest)


if __name__ == "__main__":
    main()
