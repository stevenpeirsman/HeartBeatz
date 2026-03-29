"""
HeartBeatz Sensor Node Enclosure — Parametric CadQuery Model
=============================================================
Generates a STEP file for import into Fusion 360.

Components housed:
  - ESP32-S3 DevKitC-1:    70 × 28 × 8mm
  - TECNOIOT 18650 UPS:    90 × 22 × 28.5mm
  - 2× 18650 cells:        18mm Ø × 65mm each

Design: Two-piece snap-fit (base + lid), tool-free assembly.
Printer: Bambu Lab H2D, 0.2mm layer height, PETG.
"""

import cadquery as cq

# ==============================================================================
# PARAMETRIC DIMENSIONS
# ==============================================================================

# Wall thickness and tolerances
WALL = 2.5            # Wall thickness (mm)
TOLERANCE = 0.8       # Clearance around components (mm per side)
CORNER_R = 4.0        # External corner radius (mm)

# Component dimensions (verified)
ESP32_W, ESP32_D, ESP32_H = 70.0, 28.0, 8.0      # ESP32-S3 DevKitC-1
UPS_W, UPS_D, UPS_H = 90.0, 22.0, 28.5            # TECNOIOT UPS board
CELL_DIA, CELL_L = 18.0, 65.0                       # 18650 battery cell

# Layout: ESP32 on top, UPS + batteries below
# ESP32 antenna end must be near enclosure opening
ANTENNA_CLEARANCE = 5.0  # Extra space at antenna end

# Internal dimensions
internal_w = max(ESP32_W + ANTENNA_CLEARANCE, UPS_W) + 2 * TOLERANCE
internal_d = max(ESP32_D, CELL_L) + 2 * TOLERANCE
internal_h = ESP32_H + max(UPS_H, CELL_DIA * 2 + 2) + 3 * TOLERANCE

# External dimensions
EXT_W = internal_w + 2 * WALL
EXT_D = internal_d + 2 * WALL
EXT_H = internal_h + 2 * WALL

# Snap-fit clips
CLIP_W = 8.0          # Clip width
CLIP_H = 3.0          # Clip height (overhang)
CLIP_DEPTH = 1.0      # How far clip protrudes
CLIP_OFFSET = 15.0    # Distance from center on each side

# Mounting holes (for wall/tripod mount)
MOUNT_HOLE_DIA = 4.2  # M4 clearance
MOUNT_HOLE_SPACING = 60.0

# USB-C access cutout
USB_C_W = 12.0
USB_C_H = 7.0

# Antenna slot (open end for WiFi signal)
ANTENNA_SLOT_W = 20.0
ANTENNA_SLOT_H = internal_h

# Status LED hole
LED_DIA = 3.0

# Split height (where base meets lid)
SPLIT_H = EXT_H * 0.6  # 60% base, 40% lid

print(f"Internal cavity: {internal_w:.1f} × {internal_d:.1f} × {internal_h:.1f} mm")
print(f"External dims:   {EXT_W:.1f} × {EXT_D:.1f} × {EXT_H:.1f} mm")

# ==============================================================================
# BASE
# ==============================================================================

base = (
    cq.Workplane("XY")
    .box(EXT_W, EXT_D, SPLIT_H)
    .translate((0, 0, SPLIT_H / 2))
    .edges("|Z").fillet(CORNER_R)
)

# Hollow out
base = base.faces(">Z").shell(-WALL)

# --- Battery cradle ribs (keep 18650 cells in place) ---
cradle_y_offset = -internal_d / 4
for i in range(3):
    rib_x = -internal_w / 3 + i * (internal_w / 3)
    rib = (
        cq.Workplane("XZ")
        .center(rib_x, WALL + CELL_DIA)
        .rect(2, CELL_DIA * 1.2)
        .extrude(2)
        .translate((0, cradle_y_offset - 1, 0))
    )
    base = base.union(rib)

# --- USB-C port cutout (one end) ---
usb_cutout = (
    cq.Workplane("YZ")
    .center(0, SPLIT_H / 2)
    .rect(USB_C_H, USB_C_W)
    .extrude(WALL + 1)
    .translate((EXT_W / 2 - 0.5, 0, 0))
)
base = base.cut(usb_cutout)

# --- Antenna slot (open end for WiFi) ---
antenna_slot = (
    cq.Workplane("YZ")
    .center(0, SPLIT_H / 2 + 2)
    .rect(ANTENNA_SLOT_H * 0.6, ANTENNA_SLOT_W)
    .extrude(WALL + 1)
    .translate((-EXT_W / 2 - 0.5, 0, 0))
)
base = base.cut(antenna_slot)

# --- Status LED hole ---
led_hole = (
    cq.Workplane("YZ")
    .center(EXT_D / 4, SPLIT_H * 0.7)
    .circle(LED_DIA / 2)
    .extrude(WALL + 1)
    .translate((EXT_W / 2 - 0.5, 0, 0))
)
base = base.cut(led_hole)

# --- Mounting holes (bottom face) ---
for mx in [-MOUNT_HOLE_SPACING / 2, MOUNT_HOLE_SPACING / 2]:
    mount = (
        cq.Workplane("XY")
        .center(mx, 0)
        .circle(MOUNT_HOLE_DIA / 2)
        .extrude(WALL + 1)
        .translate((0, 0, -0.5))
    )
    base = base.cut(mount)

# --- Snap-fit clip recesses on base top edge ---
for cy in [-CLIP_OFFSET, CLIP_OFFSET]:
    clip_recess = (
        cq.Workplane("XZ")
        .center(EXT_W / 2, SPLIT_H - CLIP_H / 2)
        .rect(CLIP_DEPTH + 0.5, CLIP_H + 0.5)
        .extrude(CLIP_W)
        .translate((0, cy - CLIP_W / 2, 0))
    )
    base = base.cut(clip_recess)


# ==============================================================================
# LID
# ==============================================================================

LID_TOTAL_H = EXT_H - SPLIT_H

lid = (
    cq.Workplane("XY")
    .box(EXT_W, EXT_D, LID_TOTAL_H)
    .translate((0, 0, SPLIT_H + LID_TOTAL_H / 2))
    .edges("|Z").fillet(CORNER_R)
)

# Inner lip that sits inside base
lip_clearance = 0.3  # Printing tolerance for fit
lid_lip = (
    cq.Workplane("XY")
    .box(EXT_W - 2 * WALL + lip_clearance, EXT_D - 2 * WALL + lip_clearance, 3.0)
    .translate((0, 0, SPLIT_H + 1.5))
)
lid = lid.cut(lid_lip)

# --- Snap-fit clips on lid ---
for cy in [-CLIP_OFFSET, CLIP_OFFSET]:
    for side_x in [EXT_W / 2 - WALL, -EXT_W / 2 + WALL]:
        clip = (
            cq.Workplane("XY")
            .box(CLIP_DEPTH, CLIP_W, CLIP_H)
            .translate((side_x, cy, SPLIT_H + CLIP_H / 2))
        )
        lid = lid.union(clip)

# --- Ventilation holes in lid ---
for i in range(4):
    vx = (i - 1.5) * 18
    vent = (
        cq.Workplane("XY")
        .center(vx, 0)
        .rect(12, 2.5)
        .extrude(WALL + 1)
        .translate((0, 0, EXT_H - 0.5))
    )
    lid = lid.cut(vent)


# ==============================================================================
# COMPONENT PLACEHOLDERS (for fit visualization in Fusion 360)
# ==============================================================================

# ESP32 (top layer)
esp32_ref = (
    cq.Workplane("XY")
    .box(ESP32_W, ESP32_D, ESP32_H)
    .translate((-ANTENNA_CLEARANCE / 2, internal_d / 4, WALL + UPS_H + TOLERANCE + ESP32_H / 2))
)

# UPS board (middle layer)
ups_ref = (
    cq.Workplane("XY")
    .box(UPS_W, UPS_D, UPS_H)
    .translate((0, -internal_d / 4, WALL + CELL_DIA + TOLERANCE + UPS_H / 2))
)

# Battery cells (bottom layer)
cell1_ref = (
    cq.Workplane("YZ")
    .circle(CELL_DIA / 2)
    .extrude(CELL_L)
    .translate((-CELL_L / 2, -internal_d / 4 - CELL_DIA / 2, WALL + CELL_DIA / 2))
)

cell2_ref = (
    cq.Workplane("YZ")
    .circle(CELL_DIA / 2)
    .extrude(CELL_L)
    .translate((-CELL_L / 2, -internal_d / 4 + CELL_DIA / 2, WALL + CELL_DIA / 2))
)


# ==============================================================================
# EXPORT
# ==============================================================================

assembly = base.union(lid)

output_dir = "/sessions/sharp-awesome-albattani/mnt/HeartBeatz/cadquery"

cq.exporters.export(base, f"{output_dir}/sensor_node_base.step")
cq.exporters.export(lid, f"{output_dir}/sensor_node_lid.step")
cq.exporters.export(assembly, f"{output_dir}/sensor_node_assembly.step")
cq.exporters.export(esp32_ref, f"{output_dir}/ref_esp32_s3.step")

print(f"\nExported STEP files to {output_dir}/")
print("  sensor_node_base.step     — Print this (base with battery cradle)")
print("  sensor_node_lid.step      — Print this (lid with snap-fit clips)")
print("  sensor_node_assembly.step — Combined for visualization")
print("  ref_esp32_s3.step         — ESP32 placeholder for fit-check")
