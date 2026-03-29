"""
HeartBeatz Sensor Node V2 Enclosure — Parametric CadQuery Model
================================================================
Updated for the actual hardware:
  - SparkleIoT XH-S3E ESP32-S3 N16R8: ~55 × 25.5 × 9mm (with pin headers)
    * U.FL connector on-board → pigtail → SMA panel-mount bulkhead
    * 2× USB-C ports (one end), RST + BOOT buttons, RGB LED
    * Pin headers both sides (yellow, 2.54mm pitch)
  - TECNOIOT 18650 UPS HAT: ~90 × 22 × 18mm (single 18650 cell)
    * USB-C charge port, boost converter, battery cradle
    * Sits below the ESP32, powers it via 5V pin headers
  - External SMA 2.4GHz dipole antenna (~110mm tall, 9mm base)
    * Panel-mounts through enclosure wall via SMA bulkhead nut

Design goals:
  - Vertical orientation: antenna points up, slim wall-mount profile
  - SMA bulkhead mounts through top wall, antenna sticks out
  - USB-C accessible from bottom for charging (UPS) and programming (ESP32)
  - RST button accessible through small hole
  - RGB LED visible through light pipe / window
  - Two-piece snap-fit: base (back plate) + front cover
  - Wall-mount keyhole slots on back
  - Printer: 0.2mm layer height, PETG or ABS

Dimensions reference from SparkleIoT product photo:
  - Board length: ~55mm (incl USB-C connectors)
  - Board width: ~25.5mm (incl pin headers)
  - Board height: ~9mm (PCB + tallest component)
  - USB-C connectors: 2× at one end (12mm center-to-center approx)
  - RST/BOOT buttons: top-center of board
  - U.FL connector: near antenna end (opposite from USB)
"""

import cadquery as cq

# ==============================================================================
# PARAMETRIC DIMENSIONS (all in mm)
# ==============================================================================

# --- Wall and tolerances ---
WALL = 2.0            # Shell wall thickness
TOL = 0.5             # Component clearance (per side)
CORNER_R = 3.0        # External corner fillet radius
FIT_GAP = 0.2         # Snap-fit tolerance (each side)

# --- Component measured dimensions ---
# SparkleIoT XH-S3E ESP32-S3 N16R8
ESP_L = 55.0          # Length (along USB direction)
ESP_W = 25.5          # Width (across pin headers)
ESP_H = 9.0           # Height (PCB + tallest component)

# TECNOIOT 18650 UPS HAT (with single 18650 cell installed)
UPS_L = 90.0          # Length
UPS_W = 22.0          # Width
UPS_H = 18.0          # Height (board + 18650 cell)

# SMA bulkhead connector
SMA_THREAD_DIA = 6.4  # SMA thread outer diameter
SMA_NUT_FLAT = 8.0    # Nut across-flats
SMA_BODY_LEN = 10.0   # Thread length protruding inside

# External dipole antenna
ANTENNA_BASE_DIA = 9.0
ANTENNA_HEIGHT = 110.0  # Not modeled, just for reference

# USB-C connector cutout
USBC_W = 9.5          # Width of USB-C plug
USBC_H = 3.5          # Height of USB-C plug
USBC_SPACING = 12.0   # Center-to-center of the two USB-C ports

# --- Layout strategy ---
# Vertical enclosure: ESP32 on top, UPS below
# Antenna points UP through the top wall via SMA bulkhead
# USB-C ports face DOWN (bottom of enclosure)
#
#     [antenna]
#   ┌───────────┐ ← SMA bulkhead hole in top wall
#   │  ESP32-S3 │ ← U.FL cable routes to SMA
#   │───────────│ ← separator shelf
#   │  UPS HAT  │ ← 18650 battery
#   │  + cell   │
#   └─────┬─────┘ ← USB-C cutouts in bottom wall
#      [USB-C]

# Internal cavity sizing
CAVITY_W = max(ESP_W, UPS_W) + 2 * TOL         # Width (across boards)
CAVITY_D = max(ESP_L, UPS_L) + 2 * TOL         # Depth (board length direction)
CAVITY_H = ESP_H + UPS_H + 3 * TOL + 2.0       # Height (stacked, 2mm shelf gap)

# External dimensions
EXT_W = CAVITY_W + 2 * WALL
EXT_D = CAVITY_D + 2 * WALL
EXT_H = CAVITY_H + 2 * WALL

# Shelf between ESP32 and UPS
SHELF_Z = WALL + UPS_H + TOL  # Height of separator shelf

# Base/lid split: back plate is the "base", front cover clips on
# Split along the depth axis (front/back), not top/bottom
SPLIT_DEPTH = WALL  # Front cover is essentially a flat plate with lip

print(f"═══════════════════════════════════════════")
print(f"  HeartBeatz Sensor Node V2 Enclosure")
print(f"═══════════════════════════════════════════")
print(f"  Internal cavity:  {CAVITY_W:.1f} × {CAVITY_D:.1f} × {CAVITY_H:.1f} mm")
print(f"  External size:    {EXT_W:.1f} × {EXT_D:.1f} × {EXT_H:.1f} mm")
print(f"  Shelf at Z:       {SHELF_Z:.1f} mm from bottom")
print(f"═══════════════════════════════════════════")

# ==============================================================================
# BASE (back plate + side walls + internal features)
# ==============================================================================

# Main box body (open front face)
base = (
    cq.Workplane("XY")
    .box(EXT_W, EXT_D, EXT_H)
    .translate((0, 0, EXT_H / 2))
    .edges("|Z").fillet(CORNER_R)
)

# Hollow out (shell removes the +Y face = open front)
base = (
    base
    .faces(">Y").shell(-WALL)
)

# --- Internal shelf to separate ESP32 (top) from UPS (bottom) ---
shelf = (
    cq.Workplane("XY")
    .box(CAVITY_W - 2, CAVITY_D - 2, 1.5)
    .translate((0, 0, SHELF_Z + 0.75))
)
base = base.union(shelf)

# --- SMA bulkhead hole (top wall, centered) ---
# The SMA connector threads through a hole in the top wall
sma_hole = (
    cq.Workplane("XY")
    .center(0, 0)
    .circle(SMA_THREAD_DIA / 2 + 0.2)  # 0.2mm clearance
    .extrude(WALL + 1)
    .translate((0, 0, EXT_H - WALL - 0.5))
)
base = base.cut(sma_hole)

# Flat recess around SMA hole for nut seating
sma_recess = (
    cq.Workplane("XY")
    .center(0, 0)
    .polygon(6, SMA_NUT_FLAT + 1.0)  # Hexagonal for nut
    .extrude(2.0)
    .translate((0, 0, EXT_H - 2.0))
)
base = base.cut(sma_recess)

# --- USB-C cutouts (bottom wall) ---
# Two USB-C ports from the ESP32, and one from the UPS
# Position based on where the boards sit in the enclosure

# ESP32 USB-C ports (two, side by side at one end of the board)
for usb_offset in [-USBC_SPACING / 2, USBC_SPACING / 2]:
    usb_cut = (
        cq.Workplane("XZ")
        .center(usb_offset, WALL + USBC_H / 2)
        .rect(USBC_W, USBC_H)
        .extrude(WALL + 1)
        .translate((0, -EXT_D / 2 - 0.5, 0))
    )
    base = base.cut(usb_cut)

# UPS USB-C port (charging, at the side)
ups_usb = (
    cq.Workplane("YZ")
    .center(-EXT_D / 4, WALL + UPS_H / 2)
    .rect(USBC_W, USBC_H)
    .extrude(WALL + 1)
    .translate((EXT_W / 2 - 0.5, 0, 0))
)
base = base.cut(ups_usb)

# --- Reset button access hole (small, top of ESP32 area) ---
rst_hole = (
    cq.Workplane("XZ")
    .center(ESP_W / 4, SHELF_Z + TOL + ESP_H / 2)
    .circle(1.5)  # 3mm diameter access hole
    .extrude(WALL + 1)
    .translate((0, EXT_D / 2 - 0.5, 0))
)
base = base.cut(rst_hole)

# --- RGB LED window (small rectangular slot) ---
led_window = (
    cq.Workplane("XZ")
    .center(0, SHELF_Z + TOL + ESP_H / 2)
    .rect(4, 3)
    .extrude(WALL + 1)
    .translate((0, EXT_D / 2 - 0.5, 0))
)
base = base.cut(led_window)

# --- Ventilation slots (side walls, passive cooling) ---
for side in [-1, 1]:
    for vz in range(3):
        vent = (
            cq.Workplane("YZ")
            .center(0, WALL + 8 + vz * 10)
            .rect(30, 2)
            .extrude(WALL + 1)
            .translate((side * (EXT_W / 2 - 0.5), 0, 0))
        )
        base = base.cut(vent)

# --- Wall-mount keyhole slots (back face) ---
keyhole_spacing = 40.0
for kx in [-keyhole_spacing / 2, keyhole_spacing / 2]:
    # Wide part (head slides in)
    kh_wide = (
        cq.Workplane("XZ")
        .center(kx, EXT_H * 0.7)
        .circle(4.0)  # 8mm diameter for screw head
        .extrude(WALL + 1)
        .translate((0, -EXT_D / 2 - 0.5, 0))
    )
    # Narrow slot (slides down to lock)
    kh_narrow = (
        cq.Workplane("XZ")
        .center(kx, EXT_H * 0.7 - 5)
        .rect(4.0, 10.0)
        .extrude(WALL + 1)
        .translate((0, -EXT_D / 2 - 0.5, 0))
    )
    base = base.cut(kh_wide)
    base = base.cut(kh_narrow)

# --- PCB mounting posts (small cylinders rising from base floor) ---
# Two posts for ESP32 (top compartment)
for px, py in [(-ESP_W / 3, 0), (ESP_W / 3, 0)]:
    post = (
        cq.Workplane("XY")
        .center(px, py)
        .circle(2.0)  # 4mm diameter post
        .extrude(1.5)
        .translate((0, 0, SHELF_Z + 1.5))
    )
    post_hole = (
        cq.Workplane("XY")
        .center(px, py)
        .circle(0.8)  # 1.6mm hole for self-tapping screw
        .extrude(1.5)
        .translate((0, 0, SHELF_Z + 1.5))
    )
    base = base.union(post).cut(post_hole)

# ==============================================================================
# FRONT COVER (clips onto open face)
# ==============================================================================

cover = (
    cq.Workplane("XY")
    .box(EXT_W, WALL, EXT_H)
    .translate((0, EXT_D / 2 - WALL / 2, EXT_H / 2))
    .edges("|Y").fillet(min(CORNER_R, WALL / 2 - 0.1))
)

# Inner lip that sits inside the base cavity
lip_h = 4.0  # How deep the lip extends into the base
lip = (
    cq.Workplane("XY")
    .box(EXT_W - 2 * WALL - 2 * FIT_GAP, lip_h, EXT_H - 2 * WALL - 2 * FIT_GAP)
    .translate((0, EXT_D / 2 - WALL - lip_h / 2, EXT_H / 2))
)
cover = cover.union(lip)

# --- Snap clips on cover inner lip (engage with recesses in base) ---
clip_w = 6.0
clip_overhang = 1.0
for cz in [EXT_H * 0.3, EXT_H * 0.7]:
    for cx in [-EXT_W / 3, EXT_W / 3]:
        clip = (
            cq.Workplane("XZ")
            .center(cx, cz)
            .rect(clip_w, clip_overhang * 2)
            .extrude(clip_overhang)
            .translate((0, EXT_D / 2 - WALL - lip_h + 0.5, 0))
        )
        cover = cover.union(clip)

# --- Matching openings in cover for LED window and reset ---
# LED window in cover
led_cover = (
    cq.Workplane("XZ")
    .center(0, SHELF_Z + TOL + ESP_H / 2)
    .rect(4, 3)
    .extrude(WALL + lip_h + 1)
    .translate((0, EXT_D / 2 - WALL - lip_h - 0.5, 0))
)
cover = cover.cut(led_cover)

# Reset button hole in cover
rst_cover = (
    cq.Workplane("XZ")
    .center(ESP_W / 4, SHELF_Z + TOL + ESP_H / 2)
    .circle(1.5)
    .extrude(WALL + lip_h + 1)
    .translate((0, EXT_D / 2 - WALL - lip_h - 0.5, 0))
)
cover = cover.cut(rst_cover)

# ==============================================================================
# EXPORT STEP FILES
# ==============================================================================

# Export base (back plate with walls)
cq.exporters.export(base, "sensor_node_v2_base.step")
print("Exported: sensor_node_v2_base.step")

# Export cover (front panel)
cq.exporters.export(cover, "sensor_node_v2_cover.step")
print("Exported: sensor_node_v2_cover.step")

# Export assembly (for visualization)
assembly = base.union(cover)
cq.exporters.export(assembly, "sensor_node_v2_assembly.step")
print("Exported: sensor_node_v2_assembly.step")

print(f"\nAssembly notes:")
print(f"  1. Insert TECNOIOT UPS + 18650 cell into bottom compartment")
print(f"  2. Route USB-C cable from UPS to ESP32 5Vin/GND (or use pin headers)")
print(f"  3. Place ESP32 on top shelf, U.FL end facing UP")
print(f"  4. Connect U.FL pigtail to SMA bulkhead through top hole")
print(f"  5. Tighten SMA nut from outside, screw on antenna")
print(f"  6. Snap front cover into place")
print(f"  7. Mount on wall using keyhole slots (40mm spacing)")
