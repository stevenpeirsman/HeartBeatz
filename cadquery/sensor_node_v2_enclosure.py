"""
HeartBeatz Sensor Node V2 Enclosure
====================================
Based directly on ESP32-S3-WROOM case STL (33 × 68.5 × 17mm).
Scaled up to hold: UPS HAT (bottom) + ESP32-S3 (middle) + radar (top).
Adds: SMA antenna mount, 16mm power button, 3× USB-C ports.

Design: Flat tub + snap-on lid (same style as reference STL).
Button caps for RST/BOOT are part of the lid.
Vent pattern matches the STL's two-column slot layout.
"""

import cadquery as cq
import math

# ==============================================================================
# PARAMETRIC DIMENSIONS
# ==============================================================================

WALL = 2.0
TOL = 0.5
CORNER_R = 2.0
FIT_GAP = 0.2

# Components
ESP_L, ESP_W, ESP_H = 55.0, 25.5, 9.0
UPS_L, UPS_W, UPS_H = 90.0, 22.0, 18.0
RADAR_W, RADAR_D, RADAR_H = 20.0, 20.0, 2.5

SMA_THREAD_DIA = 6.4
SMA_NUT_FLAT = 8.0

PWR_BTN_MOUNT_DIA = 16.4
PWR_BTN_BODY_OD = 18.8
PWR_BTN_RIGID_DEPTH = 11.0

USBC_W, USBC_H = 9.5, 3.5

SHELF_T = 1.5  # shelf thickness

# --- Cavity & exterior ---
# Reference STL: 33w × 68.5l for a 25.5w ESP32 → 3.75mm margin per side
# We keep the same margin ratio.
MARGIN = 3.5
CAVITY_W = max(ESP_W, UPS_W) + 2 * TOL          # 26.5
CAVITY_L = UPS_L + 2 * TOL                       # 91.0
CAVITY_H = (WALL                                  # floor
            + UPS_H + TOL                         # UPS compartment
            + SHELF_T                             # shelf1
            + ESP_H + TOL                         # ESP32 compartment
            + SHELF_T                             # shelf2
            + RADAR_H + TOL + 1.0)                # radar + headroom

EXT_W = CAVITY_W + 2 * WALL       # 30.5
EXT_L = CAVITY_L + 2 * WALL       # 95.0
TUB_H = CAVITY_H + WALL           # tub total height (without lid)

# Shelf Z positions (from Z=0 floor)
S1_Z = WALL + UPS_H + TOL                         # ~20.5  UPS → ESP
S2_Z = S1_Z + SHELF_T + ESP_H + TOL               # ~31.5  ESP → radar

# Lid dimensions (matching STL proportions: ~2mm top + ~3mm lip)
LID_TOP = 2.0
LID_LIP = 4.0
LID_H = LID_TOP + LID_LIP  # 6mm

# Power button: on lid, offset toward +Y end (away from center)
BTN_X = 0.0
BTN_Y = EXT_L / 4   # ~23.75mm from center

CUT_T = WALL + 4  # Through-wall cut thickness

print(f"{'='*50}")
print(f"  HeartBeatz Sensor Node V2")
print(f"{'='*50}")
print(f"  Tub:   {EXT_W:.1f} x {EXT_L:.1f} x {TUB_H:.1f} mm")
print(f"  Lid:   {EXT_W:.1f} x {EXT_L:.1f} x {LID_H:.1f} mm")
print(f"  Total: {EXT_W:.1f} x {EXT_L:.1f} x {TUB_H + LID_TOP:.1f} mm")
print(f"{'='*50}")

# ==============================================================================
# BASE TUB
# ==============================================================================

# Outer box
base = (
    cq.Workplane("XY")
    .box(EXT_W, EXT_L, TUB_H)
    .edges("|Z").fillet(CORNER_R)
)

# Cavity (open top)
cav = (
    cq.Workplane("XY")
    .box(CAVITY_W, CAVITY_L, TUB_H)  # overshoots top
    .translate((0, 0, WALL))
)
base = base.cut(cav)

# Shelf 1 (UPS → ESP32)
sh1 = cq.Workplane("XY").box(CAVITY_W - 1, CAVITY_L - 4, SHELF_T).translate((0, 0, S1_Z + SHELF_T / 2))
base = base.union(sh1)

# Shelf 2 (ESP32 → Radar), with wire slot + button body clearance
sh2 = cq.Workplane("XY").box(CAVITY_W - 1, CAVITY_L - 4, SHELF_T).translate((0, 0, S2_Z + SHELF_T / 2))
# wire slot
ws = cq.Workplane("XY").box(10, 6, SHELF_T + 2).translate((CAVITY_W / 4, 0, S2_Z + SHELF_T / 2))
sh2 = sh2.cut(ws)
# button body clearance
bc = cq.Workplane("XY").box(PWR_BTN_BODY_OD + 2, PWR_BTN_BODY_OD + 2, SHELF_T + 2).translate((BTN_X, BTN_Y, S2_Z + SHELF_T / 2))
sh2 = sh2.cut(bc)
base = base.union(sh2)

# ESP32 mounting posts on shelf1
for px, py in [(-8, -15), (8, -15), (-8, 15), (8, 15)]:
    p = cq.Workplane("XY").center(px, py).circle(2).extrude(1.5).translate((0, 0, S1_Z + SHELF_T))
    h = cq.Workplane("XY").center(px, py).circle(0.8).extrude(2).translate((0, 0, S1_Z + SHELF_T))
    base = base.union(p).cut(h)

# Radar posts on shelf2
for rx, ry in [(-7, 0), (7, 0)]:
    rp = cq.Workplane("XY").center(rx, ry).circle(1.5).extrude(1).translate((0, 0, S2_Z + SHELF_T))
    rh = cq.Workplane("XY").center(rx, ry).circle(0.5).extrude(1.5).translate((0, 0, S2_Z + SHELF_T))
    base = base.union(rp).cut(rh)

# --- Through-wall cuts ---

# USB-C on -Y end wall: 2× ESP32 (upper) + 1× UPS (lower)
esp_usb_z = S1_Z + SHELF_T + TOL + USBC_H / 2 + 1
for dx in [-6, 6]:
    uc = cq.Workplane("XY").box(USBC_W, CUT_T, USBC_H).translate((dx, -EXT_L / 2, esp_usb_z))
    base = base.cut(uc)

ups_usb_z = WALL + USBC_H / 2 + 1
uu = cq.Workplane("XY").box(USBC_W, CUT_T, USBC_H).translate((0, -EXT_L / 2, ups_usb_z))
base = base.cut(uu)

# SMA bulkhead on +Y end wall (at ESP32 height)
sma_z = S1_Z + SHELF_T + TOL + ESP_H / 2
sma = cq.Workplane("XZ").center(0, sma_z).circle(SMA_THREAD_DIA / 2 + 0.2).extrude(CUT_T).translate((0, EXT_L / 2 - CUT_T / 2, 0))
base = base.cut(sma)
# Nut recess
sr = cq.Workplane("XZ").center(0, sma_z).polygon(6, SMA_NUT_FLAT + 1).extrude(2.5).translate((0, EXT_L / 2 - WALL - 2.5, 0))
base = base.cut(sr)

# Side wall vents (matching STL: small horizontal slots on side walls)
for side in [-1, 1]:
    for vi in range(4):
        vz = WALL + 5 + vi * 7
        if vz < TUB_H - 3:
            v = cq.Workplane("XY").box(CUT_T, 25, 1.5).translate((side * EXT_W / 2, 0, vz))
            base = base.cut(v)

# Keyhole wall-mount slots on back (-Z bottom face)
for ky in [-22, 22]:
    kw = cq.Workplane("XY").box(7, 7, CUT_T).translate((0, ky, 0))
    kn = cq.Workplane("XY").box(3.5, 10, CUT_T).translate((0, ky - 4, 0))
    base = base.cut(kw).cut(kn)

# Ledge for lid lip to sit on (step inward at top of tub)
ledge_cut = (
    cq.Workplane("XY")
    .box(CAVITY_W - 0.3, CAVITY_L - 0.3, LID_LIP + 0.5)
    .translate((0, 0, TUB_H - LID_LIP / 2))
)
ledge_inner = (
    cq.Workplane("XY")
    .box(CAVITY_W - 2 * WALL + 0.3, CAVITY_L - 2 * WALL + 0.3, LID_LIP + 1)
    .translate((0, 0, TUB_H - LID_LIP / 2))
)
base = base.cut(ledge_cut.cut(ledge_inner))

# ==============================================================================
# LID — matches reference STL style
# ==============================================================================

lid_base_z = TUB_H  # bottom of lid top panel

# Top panel
lid = (
    cq.Workplane("XY")
    .box(EXT_W, EXT_L, LID_TOP)
    .translate((0, 0, lid_base_z + LID_TOP / 2))
    .edges("|Z").fillet(CORNER_R)
)

# Lip (inserts into tub)
lip = (
    cq.Workplane("XY")
    .box(CAVITY_W - 2 * FIT_GAP - 0.3, CAVITY_L - 2 * FIT_GAP - 0.3, LID_LIP)
    .translate((0, 0, lid_base_z - LID_LIP / 2))
)
lid = lid.union(lip)

# Snap clips on lip
for cy in [-EXT_L * 0.3, EXT_L * 0.3]:
    for side in [-1, 1]:
        cl = (
            cq.Workplane("YZ").center(cy, lid_base_z - LID_LIP * 0.6)
            .rect(8, 1.2).extrude(0.8)
            .translate((side * (CAVITY_W / 2 - FIT_GAP - 1), 0, 0))
        )
        lid = lid.union(cl)

# --- Vent pattern: two columns of horizontal pill-shaped slots ---
# Matching the STL layout: slots at ±X_COL, spaced along Y
X_COL_L = -7.0   # Left column center X
X_COL_R = 7.0    # Right column center X
SLOT_W = 12.0    # Slot length (along X)
SLOT_H = 1.8     # Slot height (Z, through-hole)
SLOT_R = 0.9     # End radius for pill shape
SLOT_SPACE = 3.5 # Y spacing between slots

# Compute slot Y positions, avoiding button area and power button
slot_positions = []
y_start = -CAVITY_L / 2 + 8
y_end = CAVITY_L / 2 - 8
y = y_start
while y <= y_end:
    # Skip if too close to power button
    if abs(y - BTN_Y) > PWR_BTN_MOUNT_DIA / 2 + 3:
        slot_positions.append(y)
    y += SLOT_SPACE

for sy in slot_positions:
    for sx in [X_COL_L, X_COL_R]:
        slot = (
            cq.Workplane("XZ")
            .center(sx, lid_base_z + LID_TOP / 2)
            .slot2D(SLOT_W, SLOT_H)
            .extrude(CUT_T)
            .translate((0, sy, 0))
        )
        lid = lid.cut(slot)

# --- Power button hole through lid ---
bh = (
    cq.Workplane("XY").center(BTN_X, BTN_Y)
    .circle(PWR_BTN_MOUNT_DIA / 2).extrude(CUT_T)
    .translate((0, 0, lid_base_z - 2))
)
lid = lid.cut(bh)

# Boss ring (slight raised surround, matching STL antenna area style)
boss = (
    cq.Workplane("XY").center(BTN_X, BTN_Y)
    .circle(PWR_BTN_MOUNT_DIA / 2 + 1.5).extrude(0.6)
    .translate((0, 0, lid_base_z + LID_TOP))
)
boss_h = (
    cq.Workplane("XY").center(BTN_X, BTN_Y)
    .circle(PWR_BTN_MOUNT_DIA / 2).extrude(1.5)
    .translate((0, 0, lid_base_z + LID_TOP - 0.5))
)
lid = lid.union(boss).cut(boss_h)

# --- Radar thin-wall window ---
# Centered on lid, under the radar position. Pocket from inside, leave 0.6mm.
rwin_size = RADAR_W + 4  # 24mm square
rwin_pocket = (
    cq.Workplane("XY")
    .box(rwin_size, rwin_size, LID_TOP - 0.6)
    .translate((0, 0, lid_base_z + 0.3 + (LID_TOP - 0.6) / 2))
)
lid = lid.cut(rwin_pocket)

# Outline indicator on top surface
for d, s in [(0.25, rwin_size + 1.5), (0.3, rwin_size - 0.5)]:
    oi = cq.Workplane("XY").box(s, s, d).translate((0, 0, lid_base_z + LID_TOP - d / 2))
    lid = lid.cut(oi)

# --- Button caps (RST + BOOT) — integrated into lid ---
# Reference STL has one ~5×5mm button cap at X≈[-8,-3], Y≈[-12,-8].
# Our ESP32 sits on shelf1 facing UP through the lid.
# RST and BOOT are near the -Y end (USB end) of the board.

BTN_CAP = 5.0       # Cap face size (square)
BTN_GAP = 0.6       # Gap around cap (air gap for flexure)
BTN_PROUD = 0.5     # How far cap sits above lid surface
BTN_NUB = 1.5       # Contact nub diameter
BTN_NUB_L = LID_LIP - 0.5  # Nub length reaching toward PCB

# Button positions on lid (relative to lid center)
RST_X = 6.5         # Right of center
RST_Y = -EXT_L / 4  # Toward -Y (USB end)
BOOT_X = -6.5       # Left of center
BOOT_Y = RST_Y      # Same Y as RST

lid_top_z = lid_base_z + LID_TOP

for bx, by in [(RST_X, RST_Y), (BOOT_X, BOOT_Y)]:
    # Cut gap trench around the button cap area (U-shape, leaving two bridges)
    # The gap is a rectangular slot around 3 sides, with 2 bridges on the remaining side

    gap_outer = BTN_CAP + 2 * BTN_GAP  # Total pocket size

    # Full rectangular pocket (cuts through lid)
    pocket = (
        cq.Workplane("XY")
        .box(gap_outer, gap_outer, LID_TOP + BTN_PROUD + 0.5)
        .translate((bx, by, lid_base_z + LID_TOP / 2))
    )
    lid = lid.cut(pocket)

    # Re-add the button cap island (slightly smaller, bridges on ±X sides)
    # Cap body (fills the pocket, connected to lid by thin bridges)
    cap = (
        cq.Workplane("XY")
        .box(BTN_CAP, BTN_CAP, LID_TOP + BTN_PROUD)
        .translate((bx, by, lid_base_z + (LID_TOP + BTN_PROUD) / 2))
    )
    lid = lid.union(cap)

    # Bridges connecting cap to lid (on ±X sides, thin)
    for bside in [-1, 1]:
        bridge = (
            cq.Workplane("XY")
            .box(BTN_GAP + 0.2, 1.2, 0.5)
            .translate((bx + bside * (BTN_CAP / 2 + BTN_GAP / 2), by, lid_base_z + 0.25))
        )
        lid = lid.union(bridge)

    # Contact nub on underside (presses PCB button when cap is pushed)
    nub = (
        cq.Workplane("XY").center(bx, by)
        .circle(BTN_NUB / 2).extrude(BTN_NUB_L)
        .translate((0, 0, lid_base_z - BTN_NUB_L))
    )
    lid = lid.union(nub)

# --- LED window (small square, thin-wall diffuser) ---
LED_Y = RST_Y + 8  # Between buttons and center, near ESP32 LED position
led_pocket = (
    cq.Workplane("XY")
    .box(4, 4, LID_TOP - 0.6)
    .translate((0, LED_Y, lid_base_z + 0.3 + (LID_TOP - 0.6) / 2))
)
lid = lid.cut(led_pocket)

# ==============================================================================
# REFERENCE BODIES (visualization only)
# ==============================================================================

ref_ups = cq.Workplane("XY").box(UPS_W, UPS_L, UPS_H).translate((0, 0, WALL + UPS_H / 2))
ref_esp = cq.Workplane("XY").box(ESP_W, ESP_L, ESP_H).translate((0, 0, S1_Z + SHELF_T + TOL + ESP_H / 2))
ref_radar = cq.Workplane("XY").box(RADAR_W, RADAR_D, RADAR_H).translate((0, 0, S2_Z + SHELF_T + TOL + RADAR_H / 2))
ref_btn = (
    cq.Workplane("XY").center(BTN_X, BTN_Y)
    .circle(PWR_BTN_BODY_OD / 2).extrude(PWR_BTN_RIGID_DEPTH)
    .translate((0, 0, lid_base_z - PWR_BTN_RIGID_DEPTH))
)

# ==============================================================================
# EXPORT
# ==============================================================================

cq.exporters.export(base, "sensor_node_v2_base.step")
print("Exported: sensor_node_v2_base.step")

cq.exporters.export(lid, "sensor_node_v2_lid.step")
print("Exported: sensor_node_v2_lid.step")

asm = cq.Assembly()
asm.add(base, name="base", color=cq.Color(0.75, 0.75, 0.75, 0.6))
asm.add(lid, name="lid", color=cq.Color(0.3, 0.5, 0.85, 0.6))
asm.add(ref_ups, name="ref_ups", color=cq.Color(0.2, 0.8, 0.2, 0.8))
asm.add(ref_esp, name="ref_esp", color=cq.Color(0.9, 0.3, 0.1, 0.8))
asm.add(ref_radar, name="ref_radar", color=cq.Color(0.9, 0.9, 0.1, 0.8))
asm.add(ref_btn, name="ref_pwr_btn", color=cq.Color(0.1, 0.3, 0.9, 0.8))
asm.save("sensor_node_v2_assembly.step")
print("Exported: sensor_node_v2_assembly.step")

# Exploded
exp = cq.Assembly()
exp.add(base, name="base", color=cq.Color(0.75, 0.75, 0.75, 1.0))
exp.add(lid.translate((0, 0, 25)), name="lid_exploded", color=cq.Color(0.3, 0.5, 0.85, 1.0))
exp.save("sensor_node_v2_exploded.step")
print("Exported: sensor_node_v2_exploded.step")

print(f"\nAssembly:")
print(f"  1. UPS + 18650 in bottom compartment")
print(f"  2. ESP32 on shelf1 posts, U.FL facing +Y end")
print(f"  3. Radar on shelf2 posts, face up toward lid")
print(f"  4. SMA bulkhead in +Y end wall")
print(f"  5. Power button in lid (16mm hole), body hangs down")
print(f"  6. Close lid — RST/BOOT caps align with board buttons")
print(f"  7. USB-C: 2x ESP32 + 1x UPS on -Y end wall")
