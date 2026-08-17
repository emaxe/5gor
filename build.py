#!/usr/bin/env python3
"""build.py — собирает самодостаточный index.html из src/*.

Порядок модулей важен: конфиг -> утилиты -> системы -> игра -> main.
Поддерживает сборку ES-модулей в бандл для работы без зависимости от локального веб-сервера.
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "src"

MODULES = [
    "config.js",
    "utils.js",
    "carmodel.js",
    "eventbus.js",
    "audiocore.js",
    "audiosfx.js",
    "audioloops.js",
    "audiomusic.js",
    "audio.js",
    "input.js",
    "citygen.js",
    "pedgraph.js",
    "pedavoid.js",
    "player.js",
    "playerped.js",
    "traffic.js",
    "peds.js",
    "camera.js",
    "dialogues.js",
    "orders.js",
    "upgrades.js",
    "police.js",
    "achievements.js",
    "ui.js",
    "game.js",
    "main.js",
]

def bundle_es_module(code: str) -> str:
    """Транспилирует ES-модуль для объединения в монолитный скрипт."""
    # Удаляем операторы импорта (import ... from '...'; import '...';)
    code = re.sub(r'^\s*import\s+.*?;?\s*$', '', code, flags=re.MULTILINE)
    # Удаляем ключевое слово export перед объявлениями (export class X -> class X, export const X -> const X)
    code = re.sub(r'^\s*export\s+default\s+', '', code, flags=re.MULTILINE)
    code = re.sub(r'^\s*export\s+(class|const|function|let|var|async)\s+', r'\1 ', code, flags=re.MULTILINE)
    # Удаляем инструкции экспортных списков (export { A, B };)
    code = re.sub(r'^\s*export\s*\{[^}]*?\};?\s*$', '', code, flags=re.MULTILINE)
    return code

CSS = (SRC / "style.css").read_text(encoding="utf-8")
BODY = (SRC / "body.html").read_text(encoding="utf-8")

js_parts = []
for m in MODULES:
    code = (SRC / m).read_text(encoding="utf-8")
    bundled_code = bundle_es_module(code)
    js_parts.append(f"/* ===== {m} ===== */\n{bundled_code}")

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
<script src="https://unpkg.com/tone@14.7.77/build/Tone.js" onerror="window.__toneFailed=1"></script>
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
