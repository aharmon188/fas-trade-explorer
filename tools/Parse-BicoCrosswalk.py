"""Parse a GATS 'BICO-HS10' export report into a crosswalk and compare it with the
pilot's inferred HS-heading sets. Read-only; prints a summary."""
import csv
import json
import os
import sys

USAGE = "usage: Parse-BicoCrosswalk.py exports|imports report.csv [report.csv ...]"
if len(sys.argv) < 3 or sys.argv[1] not in ("exports", "imports"):
    sys.exit(USAGE)
DIRECTION = sys.argv[1]
SOURCES = sys.argv[2:]
OUTPUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "prototype", f"bico-crosswalk-{DIRECTION}.json")


def parse_file(source):
    rows = []
    with open(source, newline="", encoding="utf-8-sig") as handle:
        for row in csv.reader(handle):
            if len(row) >= 16 and row[1] == "World Total" and row[2]:
                rows.append(row)
    groups, members = {}, []
    for row in rows:
        path, hs10, label, code = row[2], row[3], row[4], row[15]
        if hs10:
            parent = path.rsplit(".", 1)[0]
            members.append({"hs10": hs10, "bicoCode": groups[parent]["code"],
                            "bicoName": groups[parent]["name"],
                            "topLevel": groups[parent]["top"], "description": label,
                            "value2025K": int(row[9].replace(",", "").replace("-", "") or 0)})
        else:
            top = groups[path.split(".")[0]]["name"] if "." in path else label
            groups[path] = {"code": code, "name": label, "top": top}
    return groups, members


def parse():
    groups, members, seen = {}, [], set()
    for source in SOURCES:
        file_groups, file_members = parse_file(source)
        groups.update(file_groups)
        for member in file_members:
            if member["hs10"] not in seen:
                seen.add(member["hs10"])
                members.append(member)
    return groups, members


def main():
    groups, members = parse()
    print(f"{DIRECTION}: {len(groups)} groups, {len(members)} HS10 members")
    by_group = {}
    for member in members:
        by_group.setdefault((member["bicoCode"], member["bicoName"]), []).append(member["hs10"])
    for target in ("0015AT",):
        codes = [m for g, m in by_group.items() if g[0] == target]
        print(target, [g for g in by_group if g[0] == target], len(codes[0]) if codes else 0)
    for prefix, label in (("1001", "wheat"), ("1005", "corn"), ("1201", "soybeans"), ("1006", "rice")):
        found = sorted((m["hs10"], m["bicoCode"], m["bicoName"]) for m in members if m["hs10"].startswith(prefix))
        print(f"\nHS{prefix} ({label}): {len(found)} codes in crosswalk")
        for item in found:
            print("  ", item)
    duplicates = len(members) - len({m["hs10"] for m in members})
    print("\nHS10 codes appearing in more than one group:", duplicates)
    with open(OUTPUT, "w", encoding="utf-8") as handle:
        json.dump({"direction": DIRECTION, "sources": [os.path.basename(s) for s in SOURCES],
                   "groups": [{"path": k, **v} for k, v in groups.items()],
                   "members": members}, handle, indent=1)
    print("Wrote", OUTPUT)


main()
