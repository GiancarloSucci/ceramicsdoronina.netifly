# Generates functions/catalogue.json from the site's ODS files (read-only source).
# Usage: python3 -B -I tools/build-catalogue.py [--check] [path/to/ceramicsdoronina/catalogue]
#   (no flag)  regenerate functions/catalogue.json
#   --check    regenerate in memory and exit 1 with a diff if it differs from the committed file
# Note: functions/sold.json (manual list of ids) overrides/extends `sold` at runtime.
import difflib, json, os, re, sys, unicodedata, zipfile
import xml.etree.ElementTree as ET

NS = {
    "t": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
    "o": "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
    "x": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
}
T = "{%s}" % NS["t"]
O = "{%s}" % NS["o"]

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "functions", "catalogue.json")
DEFAULT_SRC = os.path.join(HERE, "..", "..", "ceramicsdoronina", "catalogue")

# Image folder (relative to the site root) per source file.
IMG_DIRS = {
    "vasi": "images/catalogue/",
    "masterclass": "images/masterclass/",
    "certificati": "images/certificati/",
}


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


def add_unique(cat, pid, entry):
    """Insert entry; ANY duplicate id (also across files) is fatal."""
    if pid in cat:
        raise SystemExit("FATAL duplicate id: %s" % pid)
    cat[pid] = entry


def names(d):
    n = {k: str(pick(d, k)).strip() for k in ("name_it", "name_en", "name_ru")}
    for k in n:
        if not n[k]:
            n[k] = n["name_it"] or n["name_en"] or n["name_ru"]
    return n


def img(d, source):
    f = str(pick(d, "img1")).strip()
    return IMG_DIRS[source] + f if f and f != "-" else ""


def build_catalogue(src):
    """Reads the three ODS files under src and returns the catalogue dict."""
    ods = lambda n: os.path.join(src, n)
    for n in ("vasi.ods", "masterclass.ods", "certificati.ods"):
        r = read_rows(ods(n))
        print(n, len(r), "rows; columns:", list(r[0].keys()) if r else [], file=sys.stderr)
    cat = {}

    # vases (physical, one-off)
    for d in read_rows(ods("vasi.ods")):
        pid = str(pick(d, "id")).strip()
        if not pid:
            raise SystemExit("FATAL empty id in vasi.ods")
        add_unique(cat, pid, dict(type="physical", **names(d), priceCents=cents(d["price_new"]),
                                  sold=is_sold(pick(d, "venduto")), image=img(d, "vasi"), maxQty=1))

    # masterclass (digital, seats)
    for d in read_rows(ods("masterclass.ods")):
        m = re.search(r"\d+", str(pick(d, "spots")))
        seats = int(m.group()) if m else 6
        add_unique(cat, str(d["id"]).strip(), dict(type="digital", **names(d), priceCents=cents(d["price"]),
                                                   sold=is_sold(pick(d, "venduto")), image=img(d, "masterclass"), maxQty=seats))

    # gift cards (digital)
    for d in read_rows(ods("certificati.ods")):
        add_unique(cat, str(d["id"]).strip(), dict(type="digital", **names(d), priceCents=cents(d["amount_eur"]),
                                                   sold=is_sold(pick(d, "venduto")), image=img(d, "certificati"), maxQty=10))

    for k, v in cat.items():
        if v["priceCents"] <= 0:
            raise SystemExit("FATAL non-positive price: " + k)
    return cat


def check_images(cat, site_root):
    """Fatal if any image file is missing under the site root."""
    missing = [(k, v["image"]) for k, v in sorted(cat.items())
               if v["image"] and not os.path.isfile(os.path.join(site_root, v["image"]))]
    if missing:
        raise SystemExit("FATAL missing image files under %s:\n%s" % (
            site_root, "\n".join("  %s: %s" % m for m in missing)))


def render(cat):
    return json.dumps(cat, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def main(argv):
    check = "--check" in argv
    args = [a for a in argv if not a.startswith("--")]
    src = os.path.abspath(args[0] if args else DEFAULT_SRC)
    cat = build_catalogue(src)
    site_root = os.path.dirname(src)
    if os.path.isdir(os.path.join(site_root, "images")):
        check_images(cat, site_root)
    else:
        print("WARNING: no images/ folder under %s, image existence not checked" % site_root, file=sys.stderr)
    text = render(cat)
    if check:
        try:
            with open(OUT, encoding="utf-8") as f:
                current = f.read()
        except FileNotFoundError:
            current = ""
        if current != text:
            diff = difflib.unified_diff(current.splitlines(), text.splitlines(),
                                        "functions/catalogue.json (committed)", "generated from ODS", lineterm="")
            sys.stderr.write("\n".join(diff) + "\n")
            print("DRIFT: functions/catalogue.json is out of date; run tools/build-catalogue.py and commit", file=sys.stderr)
            return 1
        print("OK: catalogue.json matches the ODS files (%d products)" % len(cat), file=sys.stderr)
        return 0
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)
    print("wrote %d products to %s" % (len(cat), OUT), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
