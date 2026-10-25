# Generates functions/catalogue.json from the site's ODS files (read-only source).
# Usage: python3 -I tools/build-catalogue.py [path/to/ceramicsdoronina/catalogue]
# Note: functions/sold.json (manual list of ids) overrides/extends `sold` at runtime.
import json, os, re, sys, unicodedata, zipfile
import xml.etree.ElementTree as ET

NS = {
    "t": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
    "o": "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
    "x": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
}
T = "{%s}" % NS["t"]
O = "{%s}" % NS["o"]

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "..", "ceramicsdoronina", "catalogue")
OUT = os.path.join(HERE, "..", "functions", "catalogue.json")


def cell_val(c):
    vt = c.get(O + "value-type")
    if vt in ("float", "currency", "percentage"):
        return float(c.get(O + "value"))
    return "".join("".join(p.itertext()) + "\n" for p in c.findall("x:p", NS)).strip()


def read_rows(path):
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("content.xml"))
    table = root.find(".//t:table", NS)
    rows = []
    for r in table.findall("t:table-row", NS):
        vals = []
        for c in r.findall("t:table-cell", NS):
            rep = min(int(c.get(T + "number-columns-repeated", "1")), 50)
            vals.extend([cell_val(c)] * rep)
        rows.append(vals)
    if not rows:
        return []
    head = [str(h).strip() for h in rows[0]]
    out = []
    for r in rows[1:]:
        d = {h: (r[i] if i < len(r) else "") for i, h in enumerate(head) if h}
        if any(str(v).strip() for v in d.values()):
            out.append(d)
    return out


def norm(s):
    s = unicodedata.normalize("NFD", str(s).strip().lower())
    return "".join(ch for ch in s if unicodedata.category(ch) != "Mn")


def is_sold(v):
    return norm(v) in ("si", "yes", "sold", "true", "1", "venduto", "y")


def cents(v):
    if isinstance(v, float):
        return int(round(v * 100))
    s = str(v).strip().replace("€", "").replace(" ", "")
    if re.fullmatch(r"\d+(,\d{1,2})?", s) or re.fullmatch(r"\d+(\.\d{1,2})?", s):
        return int(round(float(s.replace(",", ".")) * 100))
    raise ValueError("ambiguous price: %r" % (v,))


def pick(d, *keys):
    for k in keys:
        for dk in d:
            if dk.lower() == k.lower() and str(d[dk]).strip() != "":
                return d[dk]
    return ""


if __name__ == "__main__":
    ods = lambda n: os.path.join(SRC, n)
    for n in ("vasi.ods", "masterclass.ods", "certificati.ods"):
        r = read_rows(ods(n))
        print(n, len(r), "rows; columns:", list(r[0].keys()) if r else [], file=sys.stderr)
    cat = {}

    def add(pid, entry):
        if pid in cat:
            raise SystemExit("FATAL duplicate id: %s" % pid)
        cat[pid] = entry

    def names(d):
        n = {k: str(pick(d, k)).strip() for k in ("name_it", "name_en", "name_ru")}
        for k in n:
            if not n[k]:
                n[k] = n["name_it"] or n["name_en"] or n["name_ru"]
        return n

    def img(d):
        f = str(pick(d, "img1")).strip()
        return "images/catalogue/" + f if f and f != "-" else ""

    # vases (physical, one-off)
    seen = set()
    for d in read_rows(ods("vasi.ods")):
        pid = str(pick(d, "id")).strip()
        if not pid:
            raise SystemExit("FATAL empty id in vasi.ods")
        if pid in seen:
            if pid == "v8" and "v9" not in seen:
                print("WARNING: duplicate id v8 (%s); assigning v9" % pick(d, "name_it"), file=sys.stderr)
                pid = "v9"
            else:
                raise SystemExit("FATAL duplicate id in vasi.ods: %s" % pid)
        seen.add(pid)
        add(pid, dict(type="physical", **names(d), priceCents=cents(d["price_new"]),
                      sold=is_sold(pick(d, "venduto")), image=img(d), maxQty=1))

    # masterclass (digital, seats)
    for d in read_rows(ods("masterclass.ods")):
        m = re.search(r"\d+", str(pick(d, "spots")))
        seats = int(m.group()) if m else 6
        add(str(d["id"]).strip(), dict(type="digital", **names(d), priceCents=cents(d["price"]),
                                       sold=is_sold(pick(d, "venduto")), image=img(d), maxQty=seats))

    # gift cards (digital)
    for d in read_rows(ods("certificati.ods")):
        add(str(d["id"]).strip(), dict(type="digital", **names(d), priceCents=cents(d["amount_eur"]),
                                       sold=is_sold(pick(d, "venduto")), image=img(d), maxQty=10))

    for k, v in cat.items():
        if v["priceCents"] <= 0:
            raise SystemExit("FATAL non-positive price: " + k)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(cat, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")
    print("wrote %d products to %s" % (len(cat), OUT), file=sys.stderr)
