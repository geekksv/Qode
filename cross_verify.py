import subprocess, sys
import qrcode
from qrcode.util import QRData, MODE_8BIT_BYTE
import qrcode.constants as c

LEVELS = {"L": c.ERROR_CORRECT_L, "M": c.ERROR_CORRECT_M, "Q": c.ERROR_CORRECT_Q, "H": c.ERROR_CORRECT_H}

def py_render(data, level_name, mask):
    q = qrcode.QRCode(error_correction=LEVELS[level_name], mask_pattern=mask)
    q.add_data(QRData(data.encode("utf-8"), mode=MODE_8BIT_BYTE, check_data=False))
    q.make(fit=True)
    return q.modules_count, [''.join('1' if x else '0' for x in row) for row in q.modules]

def go_render(data, level_name, mask):
    out = subprocess.run(["go", "run", "./cmd/verify", data, level_name, str(mask)],
                          capture_output=True, text=True, check=True).stdout.splitlines()
    header = out[0].split()
    size = int(header[header.index("size")+1])
    return size, out[1:]

tests = []
# Short strings across versions/levels/masks
short = "https://qrbit.app/x"
for level in ["L","M","Q","H"]:
    for mask in range(8):
        tests.append((short, level, mask))

# Boundary-ish and multi-block lengths (max byte capacity: L=2953 M=2331 Q=1663 H=1273)
for n in [1, 5, 17, 50, 100, 154, 155, 250, 500, 800, 1200]:
    data = "a1B2c3-" * (n//7+1)
    data = data[:n]
    tests.append((data, "M", 0))
    tests.append((data, "L", 7))
    if n <= 1600:
        tests.append((data, "Q", 2))
    if n <= 1250:
        tests.append((data, "H", 3))

# Right at/near each level's absolute max capacity, to exercise version 40.
for n, level, mask in [(2953, "L", 1), (2331, "M", 4), (1663, "Q", 5), (1273, "H", 6)]:
    data = ("a1B2c3-" * (n//7+1))[:n]
    tests.append((data, level, mask))

fails = 0
for data, level, mask in tests:
    py_size, py_grid = py_render(data, level, mask)
    go_size, go_grid = go_render(data, level, mask)
    ok = (py_size == go_size) and (py_grid == go_grid)
    status = "OK" if ok else "FAIL"
    print(f"{status}  len={len(data):5d} level={level} mask={mask} py_size={py_size} go_size={go_size}")
    if not ok:
        fails += 1
        if py_size == go_size:
            for i,(g,p) in enumerate(zip(go_grid, py_grid)):
                if g != p:
                    print("  row", i, "GO", g)
                    print("  row", i, "PY", p)
        else:
            print("  SIZE MISMATCH")

print(f"\n{len(tests)-fails}/{len(tests)} passed")
sys.exit(1 if fails else 0)
