#!/usr/bin/env python3
"""Names the `module+0xrva` frames of a Windows profile's renderer stacks.

The profiler on Windows walks the WebView2 renderer's main thread with
dbghelp, which has no symbols for msedge.dll; it records each frame as
`module+0xrva` and the modules' symbol-server keys in `native/wc_modules`.
This script fetches the PDB from the Microsoft symbol server (once, into a
cache), resolves every such frame against its public symbols with
llvm-pdbutil/llvm-undname and writes the named stacks back into the profile,
merging chains that turned out identical. Needs Homebrew LLVM
(`brew install llvm`).

    python scripts/symbolize_windows_stacks.py profiles/shararam-profile-….duckdb
"""
import json
import os
import re
import subprocess
import sys
from collections import defaultdict

import duckdb

SYMBOL_SERVER = "https://msdl.microsoft.com/download/symbols"
CACHE = os.path.expanduser(os.environ.get("SHARARAM_SYMBOL_CACHE", "~/Library/Caches/shararam-symbols"))
LLVM = next((d for d in ["/opt/homebrew/opt/llvm/bin", "/usr/local/opt/llvm/bin"] if os.path.isdir(d)), "")
PDBUTIL = os.path.join(LLVM, "llvm-pdbutil")
UNDNAME = os.path.join(LLVM, "llvm-undname")
FRAME = re.compile(r"^(\w+)\+0x([0-9a-f]+)$")
# A public symbol more than this far before the address is not its function.
MAX_DISTANCE = 1 << 20


def fetch(url, path):
    """Downloads once with curl: the PDBs are hundreds of MB and the symbol
    server's CDN stalls now and then, so resume (-C -) and give up on a
    stalled connection (--speed-time) rather than hang."""
    if os.path.exists(path):
        return True
    os.makedirs(os.path.dirname(path), exist_ok=True)
    part = path + ".part"
    print(f"  downloading {url}", file=sys.stderr)
    for _ in range(8):
        result = subprocess.run(
            ["curl", "-sSL", "--fail", "-C", "-", "--speed-limit", "20000", "--speed-time", "30",
             "--retry", "3", "--retry-all-errors", "-o", part, url],
            capture_output=True, text=True,
        )
        if result.returncode == 0:
            os.replace(part, path)
            return True
        if result.returncode == 22:  # HTTP error (404: private build)
            print(f"  no {os.path.basename(path)}: {result.stderr.strip()}", file=sys.stderr)
            return False
        print(f"  {result.stderr.strip() or 'stalled'}, resuming", file=sys.stderr)
    return False


def pdb_file(module):
    """Local PDB for a module record, downloaded once from the symbol server.
    (Microsoft publishes Edge's PDBs but not its binaries, so everything is
    resolved from the PDB alone.)"""
    pdb, key = module.get("pdb"), module.get("key")
    if not pdb or not key:
        return None
    path = os.path.join(CACHE, pdb, key, pdb)
    return path if fetch(f"{SYMBOL_SERVER}/{pdb}/{key}/{pdb}", path) else None


def public_table(pdb):
    """Sorted (rva, mangled name) of the PDB's public symbols; cached next to
    the PDB because dumping msedge.dll.pdb takes minutes."""
    cache = pdb + ".publics"
    if os.path.exists(cache):
        with open(cache, encoding="utf-8") as f:
            entries = [(int(rva, 16), name) for rva, name in (line.rstrip("\n").split(" ", 1) for line in f)]
        return entries
    sections, current = {}, None
    for line in subprocess.run([PDBUTIL, "dump", "--section-headers", pdb], capture_output=True, text=True, errors="replace").stdout.splitlines():
        if match := re.search(r"SECTION HEADER #(\d+)", line):
            current = int(match.group(1))
        elif current and (match := re.match(r"\s+([0-9A-Fa-f]+) virtual address", line)):
            sections[current] = int(match.group(1), 16)
    entries, name = [], None
    print(f"  indexing public symbols of {os.path.basename(pdb)}", file=sys.stderr)
    with subprocess.Popen([PDBUTIL, "dump", "--publics", pdb], stdout=subprocess.PIPE, text=True, errors="replace") as proc:
        for line in proc.stdout:
            if match := re.search(r"S_PUB32 \[size = \d+\] `(.*)`", line):
                name = match.group(1)
            elif name and (match := re.search(r"flags = (\w+), addr = (\d+):(\d+)", line)):
                # llvm-pdbutil prints the segment offset in decimal
                segment, offset = int(match.group(2)), int(match.group(3))
                if "function" in match.group(1) and segment in sections:
                    entries.append((sections[segment] + offset, name))
                name = None
    entries.sort()
    with open(cache, "w", encoding="utf-8") as f:
        f.writelines(f"{rva:x} {name}\n" for rva, name in entries)
    return entries


def demangle(names):
    if not names:
        return {}
    out = subprocess.run([UNDNAME], input="\n".join(names) + "\n", capture_output=True, text=True, errors="replace").stdout
    # llvm-undname echoes the mangled name, then the demangled one (or an error)
    lines = [line for line in out.splitlines() if line.strip()]
    result = {}
    for index in range(0, len(lines) - 1, 2):
        result[lines[index].strip()] = lines[index + 1].strip()
    return result


def shorten(name):
    """`public: bool __cdecl base::WaitableEvent::TimedWait(class base::TimeDelta) const`
    → `base::WaitableEvent::TimedWait`: the chains are read in a narrow
    panel, and the parameter list is noise there."""
    if "__cdecl " in name:
        name = name.split("__cdecl ")[-1]
    name = re.sub(r"\s+const$", "", name.strip())
    if name.endswith(")"):
        depth = 0
        for index in range(len(name) - 1, -1, -1):
            depth += 1 if name[index] == ")" else -1 if name[index] == "(" else 0
            if depth == 0:
                name = name[:index]
                break
    name = re.sub(r"^(?:(?:public|private|protected): )?(?:static |virtual )*", "", name)
    return re.sub(r"\b(?:class|struct|enum|union) ", "", name).strip()


def symbolize(pdb, rvas):
    """rva -> readable function name via the PDB's public symbols."""
    from bisect import bisect_right
    entries = public_table(pdb)
    keys = [rva for rva, _ in entries]
    hits = {}
    for rva in rvas:
        index = bisect_right(keys, rva) - 1
        if index >= 0 and rva - keys[index] <= MAX_DISTANCE:
            hits[rva] = entries[index][1]
    readable = demangle(sorted(set(hits.values())))
    return {rva: shorten(readable.get(name, name)) for rva, name in hits.items()}


def main(path):
    db = duckdb.connect(path)
    modules = {}
    for (args,) in db.sql("select args from events where cat='native' and name='wc_modules' order by ts_us").fetchall():
        for module in json.loads(args)["modules"]:
            modules[module["name"]] = module
    rows = db.sql("select seq, args from events where cat='native' and name='wc_stacks' order by ts_us").fetchall()
    wanted = defaultdict(set)
    for _, args in rows:
        for _, chain in json.loads(args)["stacks"]:
            for frame in chain.split(" ← "):
                if match := FRAME.match(frame):
                    wanted[match.group(1)].add(int(match.group(2), 16))
    names = {}
    for name, rvas in wanted.items():
        module = modules.get(name)
        if not module:
            print(f"{name}: no wc_modules record, skipped", file=sys.stderr)
            continue
        pdb = pdb_file(module)
        if not pdb:
            continue
        resolved = symbolize(pdb, sorted(rvas))
        print(f"{name}: {len(resolved)} of {len(rvas)} addresses named", file=sys.stderr)
        for rva, function in resolved.items():
            names[f"{name}+0x{rva:x}"] = f"{function} [{name}]"
    if not names:
        print("nothing to symbolise", file=sys.stderr)
        return
    for seq, args in rows:
        data = json.loads(args)
        merged = defaultdict(int)
        for count, chain in data["stacks"]:
            chain = " ← ".join(names.get(frame, frame) for frame in chain.split(" ← "))
            merged[chain] += count
        data["stacks"] = sorted(([count, chain] for chain, count in merged.items()), key=lambda s: -s[0])
        db.execute("update events set args = ? where seq = ?", [json.dumps(data, ensure_ascii=False), seq])
    db.close()
    print(f"rewrote {len(rows)} wc_stacks events in {path}", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1])
