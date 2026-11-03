#!/usr/bin/env python3
"""Descarga el GTFS de autobuses interurbanos de la Generalitat de Catalunya
y lo convierte en archivos JSON pequeños que la web carga bajo demanda.

Uso:
    python3 scripts/build_data.py                # descarga y genera public/data
    python3 scripts/build_data.py --zip g.zip    # usa un zip local

Salida (public/data/):
    meta.json            agencias, líneas, calendarios (bitmap por día), fecha
    stops.json           todas las paradas [id, nombre, lat, lon, [líneas]]
    stop/<id>.json       salidas de la parada
    route/<id>.json      recorridos, paradas y horarios de la línea
"""
import argparse
import base64
import csv
import io
import json
import shutil
import sys
import urllib.request
import zipfile
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

GTFS_URL = (
    "https://territori.gencat.cat/web/.content/home/serveis/visors-cartografia/"
    "bases-cartografiques/infraestructures-mobilitat/autobusos-interurbans/"
    "busos-interurbans-GTFS.zip"
)
OUT = Path(__file__).resolve().parent.parent / "public" / "data"
MAX_MIN = 48 * 60  # descarta horas imposibles (> 48:00) que trae el feed
SIMPLIFY_TOL = 0.00008  # ~8 m, para aligerar los trazados


def read_csv(zf, name):
    with zf.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def parse_date(s):
    return date(int(s[:4]), int(s[4:6]), int(s[6:8]))


def to_min(t):
    h, m, *_ = t.split(":")
    return int(h) * 60 + int(m)


# ---------- trazados ----------
def rdp(points, tol):
    """Douglas-Peucker iterativo."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    tol2 = tol * tol
    while stack:
        a, b = stack.pop()
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        den = dx * dx + dy * dy
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = points[i]
            if den == 0:
                d = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / den))
                d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d > best:
                best, idx = d, i
        if best > tol2:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [p for p, k in zip(points, keep) if k]


def encode_polyline(points):
    out, plat, plon = [], 0, 0
    for lat, lon in points:
        ilat, ilon = round(lat * 1e5), round(lon * 1e5)
        for v in (ilat - plat, ilon - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return "".join(out)


def dump(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", help="GTFS zip local (si no, se descarga)")
    args = ap.parse_args()

    if args.zip:
        data = Path(args.zip).read_bytes()
    else:
        print("Descargando GTFS…", file=sys.stderr)
        req = urllib.request.Request(GTFS_URL, headers={"User-Agent": "bus-penedes-horarios"})
        with urllib.request.urlopen(req, timeout=300) as r:
            data = r.read()
    zf = zipfile.ZipFile(io.BytesIO(data))

    # ---------- agencias y líneas ----------
    agencies = {a["agency_id"]: a["agency_name"].strip() for a in read_csv(zf, "agency.txt")}
    routes = {}
    for r in read_csv(zf, "routes.txt"):
        routes[r["route_id"]] = {
            "s": (r["route_short_name"] or "").strip(),
            "l": (r["route_long_name"] or "").strip(),
            "a": r["agency_id"],
            "c": (r.get("route_color") or "").strip(),
        }

    # ---------- calendarios -> bitmap de días ----------
    cal = list(read_csv(zf, "calendar.txt"))
    cdates = list(read_csv(zf, "calendar_dates.txt"))
    all_dates = [parse_date(c["start_date"]) for c in cal] + [parse_date(c["end_date"]) for c in cal]
    all_dates += [parse_date(c["date"]) for c in cdates]
    base, last = min(all_dates), max(all_dates)
    ndays = (last - base).days + 1
    days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    active = defaultdict(lambda: bytearray(ndays))
    svc_names = {}
    for c in cal:
        sid = c["service_id"]
        bits = active[sid]
        svc_names[sid] = (c.get("name") or "").strip()
        d0, d1 = parse_date(c["start_date"]), parse_date(c["end_date"])
        d = d0
        while d <= d1:
            if c[days[d.weekday()]] == "1":
                bits[(d - base).days] = 1
            d += timedelta(days=1)
    for c in cdates:
        bits = active[c["service_id"]]
        i = (parse_date(c["date"]) - base).days
        bits[i] = 1 if c["exception_type"] == "1" else 0

    def pack(bits):
        b = bytearray((len(bits) + 7) // 8)
        for i, v in enumerate(bits):
            if v:
                b[i >> 3] |= 1 << (i & 7)
        return base64.b64encode(bytes(b)).decode()

    # ---------- paradas ----------
    stops = {}
    for s in read_csv(zf, "stops.txt"):
        if s.get("location_type") not in ("", "0", None):
            continue
        try:
            stops[s["stop_id"]] = [s["stop_name"].strip(), float(s["stop_lat"]), float(s["stop_lon"])]
        except ValueError:
            continue

    # ---------- viajes ----------
    trips = {}
    for t in read_csv(zf, "trips.txt"):
        if t["route_id"] in routes:
            trips[t["trip_id"]] = t

    notes = {}
    if "nota.txt" in zf.namelist():
        for n in read_csv(zf, "nota.txt"):
            if n["nota"].strip():
                notes[n["trip_id"]] = n["nota"].strip()

    print("Leyendo stop_times…", file=sys.stderr)
    trip_st = defaultdict(list)
    for st in read_csv(zf, "stop_times.txt"):
        tid = st["trip_id"]
        if tid not in trips or st["stop_id"] not in stops:
            continue
        t = st["departure_time"] or st["arrival_time"]
        if not t:
            continue
        m = to_min(t)
        if m >= MAX_MIN:
            continue
        trip_st[tid].append((int(st["stop_sequence"]), st["stop_id"], m))

    # ---------- trazados usados ----------
    used_shapes = {t["shape_id"] for t in trips.values() if t["shape_id"]}
    print("Leyendo shapes…", file=sys.stderr)
    shape_pts = defaultdict(list)
    for p in read_csv(zf, "shapes.txt"):
        if p["shape_id"] in used_shapes:
            shape_pts[p["shape_id"]].append(
                (int(p["shape_pt_sequence"]), float(p["shape_pt_lat"]), float(p["shape_pt_lon"]))
            )
    shapes_enc = {}
    for sid, pts in shape_pts.items():
        pts.sort()
        shapes_enc[sid] = encode_polyline(rdp([(a, b) for _, a, b in pts], SIMPLIFY_TOL))

    # ---------- montar líneas y salidas por parada ----------
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    route_data = defaultdict(lambda: {"patterns": {}, "shapes": {}, "notes": {}})
    stop_deps = defaultdict(list)
    stop_routes = defaultdict(set)
    used_svcs = set()

    for tid, sts in trip_st.items():
        if len(sts) < 2:
            continue
        sts.sort()
        t = trips[tid]
        rid, svc = t["route_id"], t["service_id"]
        if svc not in active:
            continue
        used_svcs.add(svc)
        seq = tuple(s for _, s, _ in sts)
        times = [m for _, _, m in sts]
        rd = route_data[rid]
        key = (t["direction_id"] or "0", seq)
        pat = rd["patterns"].get(key)
        if pat is None:
            pat = rd["patterns"][key] = {
                "dir": int(t["direction_id"] or 0),
                "shape": t["shape_id"] or None,
                "stops": list(seq),
                "trips": [],
            }
        pat["trips"].append([tid, svc, times])
        if t["shape_id"] in shapes_enc:
            rd["shapes"][t["shape_id"]] = shapes_enc[t["shape_id"]]
        if tid in notes:
            rd["notes"][tid] = notes[tid]
        dest = seq[-1]
        for i, (_, sid, m) in enumerate(sts):
            stop_routes[sid].add(rid)
            if i < len(sts) - 1:  # en la última parada el bus no sale
                stop_deps[sid].append([m, rid, svc, dest, tid])

    for rid, rd in route_data.items():
        pats = list(rd["patterns"].values())
        for p in pats:
            p["trips"].sort(key=lambda x: x[2][0])
        pats.sort(key=lambda p: (p["dir"], -len(p["trips"])))
        dump(OUT / "route" / f"{rid}.json", {
            "id": rid,
            "patterns": pats,
            "shapes": rd["shapes"],
            "notes": rd["notes"],
        })

    for sid, deps in stop_deps.items():
        deps.sort(key=lambda d: d[0])
        dump(OUT / "stop" / f"{sid}.json", deps)

    stops_out = [
        [sid, v[0], round(v[1], 6), round(v[2], 6), sorted(stop_routes[sid])]
        for sid, v in stops.items()
        if sid in stop_routes
    ]
    dump(OUT / "stops.json", stops_out)

    live_routes = {rid: r for rid, r in routes.items() if rid in route_data}
    live_agencies = {r["a"] for r in live_routes.values()}
    dump(OUT / "meta.json", {
        "generated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "base": base.isoformat(),
        "days": ndays,
        "agencies": {a: n for a, n in agencies.items() if a in live_agencies},
        "routes": live_routes,
        "services": {s: pack(active[s]) for s in used_svcs},
        "serviceNames": {s: svc_names[s] for s in used_svcs if svc_names.get(s)},
    })
    print(
        f"OK: {len(live_routes)} líneas, {len(stops_out)} paradas, "
        f"{len(trip_st)} viajes, calendario {base} → {last}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
