# Интерактивная карта репозитория (repo-map) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сгенерировать `repo-map.html` — self-contained интерактивную карту репозитория (история коммитов + diff, дерево файлов) через скрипт `repo-map.py`.

**Architecture:** Python-скрипт читает данные из git (коммиты, diff'ы, отслеживаемые файлы), собирает JSON и встраивает его в один HTML-файл с ванильным JS. Никаких внешних зависимостей — файл открывается двойным кликом.

**Tech Stack:** Python 3 (stdlib: subprocess, json, re, html, pathlib), git CLI, ванильный HTML/CSS/JS.

Спека: `docs/plans/2026-08-09-repo-map-design.md`.

## Структура файлов

- **Create:** `repo-map.py` — генератор (данные + сборка HTML). Разделён на маркеры, чтобы таски добавляли код по частям.
- **Create:** `repo-map.html` — генерируемый артефакт (в .gitignore, не коммитится).
- **Modify:** `.gitignore` — добавить `repo-map.html`.

Разделение внутри `repo-map.py`:
- `git()`, `is_artifact()`, `collect_commits()` — слой данных (таск 1).
- `is_merge()`, `parse_diff()`, `diff_for_commit()`, `current_files()`, `collect_metrics()`, `build_data()` — разбор diff'ов и метрик (таск 1).
- `selftest()`, `main()` — проверки и сборка (таск 1–2).
- `TEMPLATE` — HTML+CSS (таск 2), с JS-маркерами `/*__JS_VIEWS__*/` и `/*__JS_DIFF__*/` (таски 3–4).

Проверки: `selftest()` внутри скрипта (Python-слой), `--json`-флаг для валидации данных, ручная проверка в браузере (JS-слой). Конвенция репо: у `build.py` тестов нет, поэтому используем лёгкий self-test вместо тестового фреймворка.

---

### Task 1: Слой данных в repo-map.py + selftest

**Files:**
- Create: `repo-map.py`

- [ ] **Step 1: Создать `repo-map.py` с полным слоем данных**

```python
#!/usr/bin/env python3
"""repo-map.py — генерирует интерактивную карту репозитория (repo-map.html).

Данные (коммиты, diff'ы, дерево файлов) читаются из git и встраиваются
в самодостаточный HTML без внешних зависимостей.

Запуск:
    python3 repo-map.py            # сгенерировать repo-map.html
    python3 repo-map.py --selftest # прогнать встроенные проверки
    python3 repo-map.py --json     # вывести данные JSON в stdout
"""
import html
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
OUT = ROOT / "repo-map.html"

# Сгенерированные артефакты не показываются на карте (дизайн-спека).
ARTIFACT_RE = re.compile(r"^(index\.html$|repo-map\.html$|.*\.log$|.*\.pid$)")


def git(*args):
    """Запускает git в корне репозитория и возвращает stdout."""
    proc = subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True, check=True
    )
    return proc.stdout


def is_artifact(path):
    """True для файлов-артефактов, которые скрываем с карты."""
    return bool(ARTIFACT_RE.match(path))


def collect_commits():
    """Все коммиты (новые сверху) в виде списка словарей."""
    raw = git("log", "--format=%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1e")
    commits = []
    for record in raw.split("\x1e"):
        record = record.strip("\n")
        if not record:
            continue
        fields = record.split("\x1f")
        commits.append({
            "hash": fields[0],
            "author": fields[1],
            "date": fields[2],
            "subject": fields[3],
            "body": fields[4].strip() if len(fields) > 4 else "",
        })
    return commits


def is_merge(commit_hash):
    """True, если у коммита больше одного родителя (diff не показываем)."""
    parents = git("rev-list", "--parents", "-n", "1", commit_hash).split()
    return len(parents) > 2


def parse_diff(text):
    """Разбирает unified-diff из `git show` в секции по файлам."""
    files = []
    current = None

    def flush():
        nonlocal current
        if current is not None and not is_artifact(current["path"]):
            files.append(current)
        current = None

    for raw in text.split("\n"):
        line = raw.rstrip("\n")
        if line.startswith("diff --git"):
            flush()
            m = re.match(r"^diff --git a/(.*) b/(.*)$", line)
            if not m:
                continue
            g1, g2 = m.group(1), m.group(2)
            path = g2 if g2 != "dev/null" else g1
            old = g1 if g1 != "dev/null" else None
            current = {
                "path": path,
                "oldPath": old,
                "status": "modified",
                "binary": False,
                "adds": 0,
                "dels": 0,
                "lines": [],
            }
            continue
        if current is None:
            continue
        if line.startswith("new file mode"):
            current["status"] = "added"
        elif line.startswith("deleted file mode"):
            current["status"] = "deleted"
        elif line.startswith("rename from "):
            current["oldPath"] = line[len("rename from "):]
        elif line.startswith("rename to "):
            current["path"] = line[len("rename to "):]
            current["status"] = "renamed"
        elif line.startswith("similarity index"):
            current["status"] = "renamed"
        elif line.startswith("Binary files ") or line.startswith("GIT binary patch"):
            current["binary"] = True
        elif line.startswith("@@") or line.startswith("index ") or \
             line.startswith("--- ") or line.startswith("+++ "):
            continue
        elif line.startswith("\\"):
            current["lines"].append({"t": " ", "c": line})
        elif line.startswith("+"):
            current["lines"].append({"t": "+", "c": line[1:]})
            current["adds"] += 1
        elif line.startswith("-"):
            current["lines"].append({"t": "-", "c": line[1:]})
            current["dels"] += 1
        elif line.startswith(" "):
            current["lines"].append({"t": " ", "c": line[1:]})
        else:
            current["lines"].append({"t": " ", "c": line})
    flush()
    return files


def diff_for_commit(commit_hash):
    """Diff коммита по файлам; merge-коммиты пропускаются."""
    if is_merge(commit_hash):
        return []
    text = git(
        "show", "--format=", "--find-renames", "-M",
        "--no-ext-diff", "--no-color", commit_hash,
    )
    return parse_diff(text)


def current_files():
    """Отслеживаемые файлы на текущем HEAD без артефактов."""
    return [p for p in git("ls-files").splitlines() if not is_artifact(p)]


def collect_metrics(commits):
    """Метрики по файлам: сколько коммитов трогали файл, +/- строк."""
    metrics = {}
    for commit in commits:
        for f in commit["files"]:
            m = metrics.setdefault(f["path"], {"commits": 0, "adds": 0, "dels": 0})
            m["commits"] += 1
            m["adds"] += f["adds"]
            m["dels"] += f["dels"]
    return metrics


def build_data():
    """Собирает итоговый словарь данных для JSON-встраивания."""
    commits = collect_commits()
    for c in commits:
        c["files"] = diff_for_commit(c["hash"])
        c["adds"] = sum(f["adds"] for f in c["files"])
        c["dels"] = sum(f["dels"] for f in c["files"])
    metrics = collect_metrics(commits)
    files = []
    for p in current_files():
        m = metrics.get(p, {"commits": 0, "adds": 0, "dels": 0})
        files.append({"path": p, "commits": m["commits"], "adds": m["adds"], "dels": m["dels"]})
    return {
        "repo": ROOT.name,
        "branch": git("branch", "--show-current").strip(),
        "commits": commits,
        "files": files,
    }


def selftest():
    """Встроенные проверки слоя данных."""
    sample = (
        "diff --git a/src/a.js b/src/a.js\n"
        "index 111..222 100644\n"
        "--- a/src/a.js\n"
        "+++ b/src/a.js\n"
        "@@ -1,2 +1,2 @@\n"
        " const x = 1\n"
        "+console.log(x)\n"
        "-console.log(y)\n"
        "\n"
        "diff --git a/old.js b/new.js\n"
        "similarity index 90%\n"
        "rename from old.js\n"
        "rename to new.js\n"
        "index 111..333 100644\n"
        "--- a/old.js\n"
        "+++ b/new.js\n"
        "@@ -1 +1 @@\n"
        "-a\n"
        "+b\n"
        "diff --git a/data.bin b/data.bin\n"
        "index 111..444 100644\n"
        "Binary files a/data.bin and b/data.bin differ\n"
        "diff --git a/index.html b/index.html\n"
        "index 111..555 100644\n"
        "--- a/index.html\n"
        "+++ b/index.html\n"
        "@@ -1 +1 @@\n"
        "-old\n"
        "+new\n"
    )
    files = parse_diff(sample)
    assert [f["path"] for f in files] == ["src/a.js", "new.js", "data.bin"], files
    assert files[0]["adds"] == 1 and files[0]["dels"] == 1, files[0]
    assert files[1]["status"] == "renamed", files[1]
    assert files[1]["oldPath"] == "old.js", files[1]
    assert files[2]["binary"] is True, files[2]
    assert files[2]["adds"] == 0 and files[2]["dels"] == 0, files[2]
    assert is_artifact("index.html")
    assert is_artifact("a.log") and is_artifact(".server.log")
    assert is_artifact("repo-map.html")
    assert not is_artifact("src/index.js") and not is_artifact("build.py")
    print("selftest OK")


def main():
    if "--selftest" in sys.argv:
        selftest()
        return
    if "--json" in sys.argv:
        print(json.dumps(build_data(), ensure_ascii=False, separators=(",", ":")))
        return
    data = build_data()
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    doc = TEMPLATE.replace("__REPO_MAP_DATA__", html.escape(payload, quote=True))
    OUT.write_text(doc, encoding="utf-8")
    print(f"OK: {OUT} ({OUT.stat().st_size // 1024} KB, "
          f"{len(data['commits'])} commits, {len(data['files'])} files)")


if __name__ == "__main__":
    TEMPLATE = ""
    main()
```

Примечание: `TEMPLATE = ""` — временный плейсхолдер; реальный шаблон появится в Task 2 (до этого `python3 repo-map.py` писать не вызываем).

- [ ] **Step 2: Прогнать selftest**

Run: `python3 repo-map.py --selftest`
Expected: `selftest OK` (иначе — упасть с assertion'ом).

- [ ] **Step 3: Проверить данные на реальном репозитории**

Run: `python3 repo-map.py --json > /tmp/repo-data.json && python3 -m json.tool /tmp/repo-data.json > /dev/null && echo "JSON VALID"`
Expected: `JSON VALID`.

Run: `python3 -c "import json; d=json.load(open('/tmp/repo-data.json')); print(len(d['commits']), len(d['files']), d['branch'])"`
Expected: `56 <кол-во файлов> main` (56 коммитов на ветке main).

- [ ] **Step 4: Проверить исключение артефактов в данных**

Run: `python3 -c "import json; d=json.load(open('/tmp/repo-data.json')); paths=[f['path'] for f in d['files']]+[c['files'][i]['path'] for c in d['commits'] for i in range(len(c['files']))]; assert not any(p=='index.html' or p.endswith('.log') or p.endswith('.pid') for p in paths); print('no artifacts')"`
Expected: `no artifacts`.

- [ ] **Step 5: Commit**

```bash
git add repo-map.py
git commit -m "feat(repo-map): слой данных карты репозитория (коммиты, diff'ы, метрики)"
```

---

### Task 2: HTML/CSS шаблон и сборка repo-map.html

**Files:**
- Modify: `repo-map.py` (заменить `TEMPLATE = ""` на полный шаблон)

- [ ] **Step 1: Добавить полный шаблон HTML/CSS в конец repo-map.py**

Заменить блок в конце файла:

```python
if __name__ == "__main__":
    TEMPLATE = ""
    main()
```

на:

```python
TEMPLATE = r"""<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__REPO__ — карта репозитория</title>
<style>
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;font:13px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#0d1117;color:#e6edf3}
header{display:flex;align-items:center;gap:16px;padding:10px 16px;background:#161b22;border-bottom:1px solid #30363d;position:sticky;top:0;z-index:10}
header h1{font-size:15px;margin:0;font-weight:600;white-space:nowrap}
header input{flex:1;max-width:420px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#e6edf3;padding:6px 10px}
header input::placeholder{color:#8b949e}
#header-stats{color:#8b949e;font-size:12px;white-space:nowrap}
.layout{display:flex;height:calc(100vh - 49px)}
aside{width:340px;min-width:340px;border-right:1px solid #30363d;display:flex;flex-direction:column;background:#161b22}
.tabs{display:flex;border-bottom:1px solid #30363d}
.tabs button{flex:1;background:none;border:none;color:#8b949e;padding:9px;cursor:pointer;font-size:13px;border-bottom:2px solid transparent;font-family:inherit}
.tabs button.active{color:#e6edf3;border-bottom-color:#1f6feb}
.tab-pane{flex:1;overflow:auto;padding:6px 0}
.tab-pane.hidden{display:none}
main{flex:1;overflow:auto;padding:16px}
.day{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:10px 12px 4px}
.commit-row{display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;border-bottom:1px solid #21262d;white-space:nowrap}
.commit-row:hover{background:#1f2937}
.hash{color:#58a6ff;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.subj{flex:1;overflow:hidden;text-overflow:ellipsis}
.adds{color:#3fb950;font-family:ui-monospace,Menlo,monospace;font-size:11px}
.dels{color:#f85149;font-family:ui-monospace,Menlo,monospace;font-size:11px}
.dir-row,.file-row{display:flex;align-items:center;gap:6px;padding:4px 12px;cursor:pointer;white-space:nowrap}
.dir-row:hover,.file-row:hover{background:#1f2937}
.dir-row .caret{width:10px;color:#8b949e}
.dir-row .dname{font-weight:600}
.file-row .fname{font-weight:400;color:#9ecbff}
.dir-children{margin-left:14px;border-left:1px solid #21262d}
.badge{background:#21262d;border-radius:8px;padding:0 6px;font-size:11px;color:#8b949e;font-family:ui-monospace,Menlo,monospace}
.placeholder{color:#8b949e;padding:40px;text-align:center}
.commit-info h2{margin:0 0 4px;font-size:16px}
.commit-info .meta{color:#8b949e;font-family:ui-monospace,Menlo,monospace;font-size:12px;margin-bottom:8px}
.commit-info .body{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:10px;white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#c9d1d9}
.diff-file{margin:10px 0;border:1px solid #30363d;border-radius:6px;overflow:hidden}
.diff-file-header{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#161b22;cursor:pointer;white-space:nowrap}
.diff-file-header .fname{font-family:ui-monospace,Menlo,monospace;font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis}
.status{color:#8b949e;font-size:11px}
.binary{color:#d29922;font-size:11px}
.diff-lines{background:#0d1117;overflow-x:auto}
.diff-line{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre;padding:0 12px}
.diff-line.add{background:rgba(46,160,67,.15);color:#a5d6a7}
.diff-line.del{background:rgba(248,81,73,.15);color:#ffa198}
.diff-line.ctx{color:#c9d1d9}
.file-history{margin-top:8px}
@media (max-width:720px){.layout{flex-direction:column;height:auto}aside{width:100%;min-width:0;border-right:none;border-bottom:1px solid #30363d;max-height:40vh}}
</style>
</head>
<body>
<header>
  <h1>__REPO__</h1>
  <input id="search" type="search" placeholder="Поиск коммитов и файлов..." autocomplete="off">
  <span id="header-stats"></span>
</header>
<div class="layout">
  <aside>
    <div class="tabs">
      <button data-tab="files" class="active">Файлы</button>
      <button data-tab="commits">Коммиты</button>
    </div>
    <div id="files-view" class="tab-pane"></div>
    <div id="commits-view" class="tab-pane hidden"></div>
  </aside>
  <main id="diff-panel">
    <div class="placeholder">Выберите коммит или файл слева</div>
  </main>
</div>
<script type="application/json" id="repo-data">__REPO_MAP_DATA__</script>
<script>
"use strict";
/*__JS_VIEWS__*/
/*__JS_DIFF__*/
</script>
</body>
</html>
"""


def main():
    if "--selftest" in sys.argv:
        selftest()
        return
    if "--json" in sys.argv:
        print(json.dumps(build_data(), ensure_ascii=False, separators=(",", ":")))
        return
    data = build_data()
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    doc = TEMPLATE.replace("__REPO__", data["repo"])
    doc = doc.replace("__REPO_MAP_DATA__", html.escape(payload, quote=True))
    OUT.write_text(doc, encoding="utf-8")
    print(f"OK: {OUT} ({OUT.stat().st_size // 1024} KB, "
          f"{len(data['commits'])} commits, {len(data['files'])} files)")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Сгенерировать файл и проверить размер**

Run: `python3 repo-map.py`
Expected: `OK: /Users/maksimklisin/Desktop/_JS/5gor/repo-map.html (<размер> KB, 56 commits, <n> files)`.

- [ ] **Step 3: Проверить, что JSON встроился и корректно экранирован**

Run: `python3 -c "import re; s=open('repo-map.html').read(); m=re.search(r'id=\"repo-data\">(.*?)</script>', s, re.S); assert m and '&quot;' in m.group(1) and '\\u003c/script\\u003e' not in m.group(1); print('embedded ok')"`
Expected: `embedded ok`.

- [ ] **Step 4: Проверить отсутствие артефактов в итоговом HTML-данных**

Run: `python3 -c "import re,html,json; s=open('repo-map.html').read(); m=re.search(r'id=\"repo-data\">(.*?)</script>', s, re.S); d=json.loads(html.unescape(m.group(1))); assert 'index.html' not in d['repo'] and not any(p=='index.html' for p in [f['path'] for f in d['files']]); print('artifacts excluded')"`
Expected: `artifacts excluded`.

- [ ] **Step 5: Commit**

```bash
git add repo-map.py
git commit -m "feat(repo-map): шаблон HTML/CSS и сборка repo-map.html"
```

---

### Task 3: JS — вкладки, дерево файлов, список коммитов, поиск

**Files:**
- Modify: `repo-map.py` (заменить `/*__JS_VIEWS__*/` в TEMPLATE)

- [ ] **Step 1: Заменить маркер `/*__JS_VIEWS__*/` в TEMPLATE на JS представлений**

```js
var DATA = JSON.parse(document.getElementById("repo-data").textContent);
var searchEl = document.getElementById("search");
var filesView = document.getElementById("files-view");
var commitsView = document.getElementById("commits-view");
var panel = document.getElementById("diff-panel");
var activeTab = "files";
var rendered = null; // {type:'commit'|'history', hash, path}

function esc(s){var d=document.createElement("div");d.textContent=s;return d.innerHTML;}

var totalAdds = DATA.commits.reduce(function(a,c){return a+c.adds;},0);
var totalDels = DATA.commits.reduce(function(a,c){return a+c.dels;},0);
document.getElementById("header-stats").textContent =
  DATA.commits.length + " коммитов · " + DATA.files.length + " файлов · +" +
  totalAdds + "/−" + totalDels;

function buildTree(list){
  var root={};
  list.forEach(function(f){
    var parts=f.path.split("/"), node=root;
    for(var i=0;i<parts.length;i++){
      var p=parts[i], last=i===parts.length-1;
      if(last){node[p]={__file:true,path:f.path,commits:f.commits,adds:f.adds,dels:f.dels};}
      else{node[p]=node[p]||{__dir:true,children:{}};node=node[p].children;}
    }
  });
  return root;
}

function renderTree(tree, container){
  var keys=Object.keys(tree).sort(function(a,b){
    var ad=!!tree[a].__file, bd=!!tree[b].__file;
    if(ad!==bd) return ad?1:-1;
    return a.localeCompare(b);
  });
  keys.forEach(function(k){
    var v=tree[k];
    if(v.__file){
      var row=document.createElement("div");
      row.className="file-row";
      row.innerHTML='<span class="fname">'+esc(k)+'</span>'+
        '<span class="badge">'+v.commits+'</span>'+
        '<span class="adds">+'+v.adds+'</span><span class="dels">-'+v.dels+'</span>';
      row.addEventListener("click",function(){showFileHistory(v.path);});
      container.appendChild(row);
    }else{
      var row=document.createElement("div");
      row.className="dir-row";
      row.innerHTML='<span class="caret">▸</span><span class="dname">'+esc(k)+'</span>';
      var child=document.createElement("div");
      child.className="dir-children";
      child.style.display="none";
      row.addEventListener("click",function(){
        var open=child.style.display!=="none";
        child.style.display=open?"none":"";
        row.querySelector(".caret").textContent=open?"▸":"▾";
      });
      renderTree(v.children, child);
      container.appendChild(row);
      container.appendChild(child);
    }
  });
}

function renderFiles(q){
  var list=DATA.files.filter(function(f){return !q||f.path.toLowerCase().indexOf(q)!==-1;});
  filesView.innerHTML="";
  renderTree(buildTree(list), filesView);
}

function renderCommits(q){
  var list=DATA.commits.filter(function(c){
    if(!q) return true;
    return c.subject.toLowerCase().indexOf(q)!==-1 ||
           c.hash.indexOf(q)!==-1 ||
           c.author.toLowerCase().indexOf(q)!==-1;
  });
  commitsView.innerHTML="";
  var groups={};
  list.forEach(function(c){var d=c.date.slice(0,10);(groups[d]=groups[d]||[]).push(c);});
  Object.keys(groups).forEach(function(day){
    var h=document.createElement("div");
    h.className="day";
    h.textContent=day;
    commitsView.appendChild(h);
    groups[day].forEach(function(c){
      var row=document.createElement("div");
      row.className="commit-row";
      row.innerHTML='<span class="hash">'+c.hash.slice(0,7)+'</span>'+
        '<span class="subj">'+esc(c.subject)+'</span>'+
        '<span class="adds">+'+c.adds+'</span><span class="dels">-'+c.dels+'</span>';
      row.addEventListener("click",function(){showCommitDiff(c.hash);});
      commitsView.appendChild(row);
    });
  });
}

var tabButtons=document.querySelectorAll(".tabs button");
tabButtons.forEach(function(btn){
  btn.addEventListener("click",function(){
    activeTab=btn.dataset.tab;
    tabButtons.forEach(function(b){b.classList.toggle("active",b===btn);});
    filesView.classList.toggle("hidden",activeTab!=="files");
    commitsView.classList.toggle("hidden",activeTab!=="commits");
    applySearch();
  });
});
```

- [ ] **Step 2: Пересобрать и проверить, что скрипт не упал при генерации**

Run: `python3 repo-map.py`
Expected: `OK: ...` без traceback.

- [ ] **Step 3: Открыть в браузере и проверить вкладки + дерево**

Run: `open repo-map.html`
Expected: страница открывается; слева вкладки «Файлы»/«Коммиты»; в «Файлах» дерево `src/`, `docs/`, `tests/` и корневые файлы; у файлов бейджи и +N/−M; клик по папке разворачивает/сворачивает. В «Коммитах» — сгруппированный по датам список, у каждого hash, сообщение, +N/−M. Правый панель показывает плейсхолдер.

- [ ] **Step 4: Проверить поиск по файлам**

В браузере ввести `carmodel` в поле поиска.
Expected: в дереве остаются только записи, содержащие `carmodel`.

- [ ] **Step 5: Commit**

```bash
git add repo-map.py
git commit -m "feat(repo-map): вкладки, дерево файлов, список коммитов, поиск"
```

---

### Task 4: JS — просмотр diff и история файла

**Files:**
- Modify: `repo-map.py` (заменить `/*__JS_DIFF__*/` в TEMPLATE)

- [ ] **Step 1: Заменить маркер `/*__JS_DIFF__*/` в TEMPLATE на JS дифф'ов**

```js
function renderDiff(files, q){
  var shown=files.filter(function(f){return !q||f.path.toLowerCase().indexOf(q)!==-1;});
  if(!shown.length){
    var p=document.createElement("div");
    p.className="placeholder";
    p.textContent="Нет файлов по запросу";
    panel.appendChild(p);
    return;
  }
  shown.forEach(function(f){
    var sec=document.createElement("section");
    sec.className="diff-file";
    var head=document.createElement("div");
    head.className="diff-file-header";
    head.innerHTML='<span class="fname">'+esc(f.path)+'</span>'+
      '<span class="adds">+'+f.adds+'</span><span class="dels">-'+f.dels+'</span>'+
      '<span class="status">'+f.status+'</span>'+
      (f.binary?'<span class="binary">binary</span>':'');
    var body=document.createElement("div");
    body.className="diff-lines";
    body.style.display="none";
    if(f.binary){
      body.textContent="Binary file — содержимое не показывается";
      body.style.display="";
    }else if(!f.lines.length){
      body.textContent="Изменений содержимого нет (rename / режим файла)";
      body.style.display="";
    }else{
      f.lines.forEach(function(ln){
        var div=document.createElement("div");
        div.className="diff-line "+(ln.t==="+"?"add":ln.t==="-"?del:"ctx");
        div.textContent=ln.t+ln.c;
        body.appendChild(div);
      });
    }
    head.addEventListener("click",function(){
      body.style.display=body.style.display==="none"?"":"none";
    });
    sec.appendChild(head);
    sec.appendChild(body);
    panel.appendChild(sec);
  });
}

function currentCommitFiles(c, path){
  return path
    ? c.files.filter(function(f){return f.path===path||f.oldPath===path;})
    : c.files;
}

function showCommitDiff(hash, path){
  var c=DATA.commits.filter(function(x){return x.hash===hash;})[0];
  if(!c) return;
  rendered={type:"commit",hash:hash,path:path};
  panel.innerHTML="";
  var info=document.createElement("div");
  info.className="commit-info";
  info.innerHTML='<h2>'+esc(c.subject)+'</h2>'+
    '<div class="meta">'+c.hash+' · '+esc(c.author)+' · '+c.date+'</div>'+
    (c.body?'<pre class="body">'+esc(c.body)+'</pre>':'');
  panel.appendChild(info);
  var files=currentCommitFiles(c,path);
  if(!files.length){
    var p=document.createElement("div");
    p.className="placeholder";
    p.textContent="Нет изменений файлов (merge или пустой коммит)";
    panel.appendChild(p);
  }else{
    renderDiff(files, searchEl.value.trim().toLowerCase());
  }
  panel.scrollTop=0;
}

function renderFileHistory(path, q){
  rendered={type:"history",path:path};
  panel.innerHTML="";
  var info=document.createElement("div");
  info.className="commit-info";
  info.innerHTML='<h2>'+esc(path)+'</h2>';
  panel.appendChild(info);
  var relevant=DATA.commits.filter(function(c){
    return c.files.some(function(f){return f.path===path||f.oldPath===path;});
  });
  if(q) relevant=relevant.filter(function(c){
    return c.subject.toLowerCase().indexOf(q)!==-1 ||
           c.hash.indexOf(q)!==-1 ||
           c.author.toLowerCase().indexOf(q)!==-1;
  });
  if(!relevant.length){
    var p=document.createElement("div");
    p.className="placeholder";
    p.textContent="Файл не менялся в истории (или нет совпадений по поиску)";
    panel.appendChild(p);
    return;
  }
  var list=document.createElement("div");
  list.className="file-history";
  relevant.forEach(function(c){
    var f=c.files.filter(function(x){return x.path===path||x.oldPath===path;})[0];
    var row=document.createElement("div");
    row.className="commit-row";
    row.innerHTML='<span class="hash">'+c.hash.slice(0,7)+'</span>'+
      '<span class="subj">'+esc(c.subject)+'</span>'+
      '<span class="adds">+'+f.adds+'</span><span class="dels">-'+f.dels+'</span>';
    row.addEventListener("click",function(){showCommitDiff(c.hash,path);});
    list.appendChild(row);
  });
  panel.appendChild(list);
}

function applySearch(){
  var q=searchEl.value.trim().toLowerCase();
  renderFiles(activeTab==="files"?q:null);
  renderCommits(activeTab==="commits"?q:null);
  if(!rendered) return;
  if(rendered.type==="commit"){
    var c=DATA.commits.filter(function(x){return x.hash===rendered.hash;})[0];
    if(!c) return;
    panel.innerHTML="";
    var info=document.createElement("div");
    info.className="commit-info";
    info.innerHTML='<h2>'+esc(c.subject)+'</h2>'+
      '<div class="meta">'+c.hash+' · '+esc(c.author)+' · '+c.date+'</div>';
    panel.appendChild(info);
    var files=currentCommitFiles(c,rendered.path);
    if(!files.length){
      var p=document.createElement("div");
      p.className="placeholder";
      p.textContent="Нет изменений файлов (merge или пустой коммит)";
      panel.appendChild(p);
    }else{
      renderDiff(files,q);
    }
  }else{
    renderFileHistory(rendered.path, q);
  }
}

searchEl.addEventListener("input", applySearch);

renderFiles(null);
renderCommits(null);
```

- [ ] **Step 2: Пересобрать**

Run: `python3 repo-map.py`
Expected: `OK: ...` без traceback.

- [ ] **Step 3: Открыть в браузере и проверить diff коммита**

Run: `open repo-map.html`
Expected: вкладка «Коммиты» → клик по любому коммиту — справа заголовок коммита (subject, hash, автор, дата, тело) и секции файлов. Клик по заголовку секции файла раскрывает/сворачивает строки: добавления зелёные с `+`, удаления красные с `-`, контекст нейтральный.

- [ ] **Step 4: Проверить историю файла**

Expected: вкладка «Файлы» → клик по `src/carmodel.js` (или любому файлу) — справа список коммитов, менявших файл, с +/- по файлу. Клик по строке коммита — diff этого коммита, ограниченный этим файлом.

- [ ] **Step 5: Проверить поиск поверх открытого diff**

В браузере: открыть diff коммита, ввести имя файла в поиск.
Expected: секции файлов в diff'е фильтруются по имени; пустой результат показывает плейсхолдер.

- [ ] **Step 6: Проверить пустые/крайние случаи**

Expected: первый коммит репозитория (весь код как добавления) отображается корректно; у diff'а с rename показывается статус `renamed` и новый путь.

- [ ] **Step 7: Commit**

```bash
git add repo-map.py
git commit -m "feat(repo-map): просмотр diff'ов и история файла"
```

---

### Task 5: Финальная проверка, .gitignore, закрытие

**Files:**
- Modify: `.gitignore` (добавить `repo-map.html`)

- [ ] **Step 1: Добавить repo-map.html в .gitignore**

Дописать в конец `.gitignore`:

```gitignore

# интерактивная карта репозитория (генерируется repo-map.py)
repo-map.html
```

- [ ] **Step 2: Полная пересборка и проверка selftest**

Run: `python3 repo-map.py --selftest && python3 repo-map.py`
Expected: `selftest OK`, затем `OK: ... (…, 56 commits, … files)`.

- [ ] **Step 3: Финальная проверка в браузере**

Run: `open repo-map.html`
Expected: страница полностью рабочая: вкладки, дерево файлов с метриками, список коммитов по датам, diff'ы (свернуть/развернуть, цвета), история файла, поиск (фильтр коммитов, файлов и секций diff). Артефакты (`index.html`, `*.log`, `*.pid`) нигде не появляются.

- [ ] **Step 4: Проверить git-статус**

Run: `git status --short`
Expected: `.gitignore` modified; `repo-map.html` untracked (не должен попасть в индекс); `repo-map.py` не менялся в этом таске.

- [ ] **Step 5: Commit**

```bash
git add .gitignore
git commit -m "chore: игнорировать сгенерированный repo-map.html"
```

- [ ] **Step 6: Завершающая проверка плана по спеке**

Пройтись по спецe `docs/plans/2026-08-09-repo-map-design.md`: история+diff, дерево файлов, исключение артефактов, бинарные/пустые/rename случаи, поиск, открытие отдельным html. Если что-то из спеки не реализовано — добавить таск до закрытия.
