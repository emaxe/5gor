#!/usr/bin/env python3
"""build.py — собирает самодостаточный index.html из src/*.

Порядок модулей важен: конфиг -> утилиты -> системы -> игра -> main.
"""
import pathlib

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "src"

MODULES = [
    "config.js",
    "utils.js",
    "audio.js",
    "input.js",
    "citygen.js",
    "player.js",
    "traffic.js",
    "peds.js",
    "camera.js",
    "orders.js",
    "upgrades.js",
    "ui.js",
    "game.js",
    "main.js",
]

CSS = (SRC / "style.css").read_text(encoding="utf-8")
BODY = (SRC / "body.html").read_text(encoding="utf-8")

js_parts = []
for m in MODULES:
    code = (SRC / m).read_text(encoding="utf-8")
    js_parts.append(f"/* ===== {m} ===== */\n{code}")

html = f"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#0d1117">
<title>5GOR — Симулятор таксиста в Пятигорске</title>
<style>
{CSS}
</style>
</head>
<body>
{BODY}
<script src="https://unpkg.com/three@0.152.2/build/three.min.js"></script>
<script>
"use strict";
{chr(10).join(js_parts)}
</script>
</body>
</html>
"""

out = ROOT / "index.html"
out.write_text(html, encoding="utf-8")
print(f"OK: {out} ({out.stat().st_size // 1024} KB)")
