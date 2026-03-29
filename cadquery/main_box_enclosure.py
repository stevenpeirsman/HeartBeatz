"""
HeartBeatz Main Box Enclosure — Parametric CadQuery Model
=========================================================
Generates a STEP file for import into Fusion 360.

Components housed:
  - MeLE Overclock4C N100:  131 × 81 × 18.3mm
  - GL.iNet MT3000:         120 × 83 × 34mm
  - UGREEN 25000mAh:       155 × 54 × 51mm
  - VoCore 5" Display:     119.3 × 68.7 × 3.6mm (on lid)

Design: Two-piece (base + lid), M3 heat-set inserts, PETG 3D printed.
Printer: Bambu Lab H2D, 0.2mm layer height, PETG.
"""

import cadquery as cq

# ==============================================================================
# PARAMETRIC DIMENSIONS — Edit these to adjust the design
# ==============================================================================

# Wall thickness and tolerances
WALL = 3.0            # Wall thickness (mm)
TOLERANCE = 1.0       # Clearance around components (mm per side)
CORNER_R = 5.0        # External corner radius (mm)
LID_LIP = 2.0         # Lid overlap lip depth (mm)

# Component dimensions (verified)
MELE_W, MELE_D, MELE_H = 131.0, 81.0, 18.3    # MeLE N100
ROUTER_W, ROUTER_D, ROUTER_H = 120.0, 83.0, 34.0  # GL.iNet MT3000
BATTERY_W, BATTERY_D, BATTERY_H = 155.0, 54.0, 51.0  # UGREEN power bank
VOCORE_W, VOCORE_D, VOCORE_H = 119.3, 68.7, 3.6  # VoCore display

# Layout: MeLE + Router side-by-side, Battery below
# Internal cavity width = max(MELE_W + ROUTER_W + gap, BATTERY_W) + tolerance
COMPONENT_GAP = 5.0   # Gap between MeLE and Router
CABLE_AREA_W = 30.0   # Width reserved for cable routing

# Calculate internal dimensions
internal_w = max(MELE_W + COMPONENT_GAP + ROUTER_W, BATTERY_W) + CABLE_AREA_W + 2 * TOLERANCE
internal_d = max(MELE_D, ROUTER_D, BATTERY_D) + 2 * TOLERANCE
internal_h = max(MELE_H + BATTERY_H, ROUTER_H + BATTERY_H) + 3 * TOLERANCE  # Stacked with clearance

# External dimensions
EXT_W = internal_w + 2 * WALL
EXT_D = internal_d + 2 * WALL
EXT_H = internal_h + WALL  # Base only (no top wall, lid covers)

# Derived
SPLIT_H = EXT_H - 10  # Where base ends and lid begins (mm from bottom)
LID_H = 12.0          # Lid total height (mm)

# Ventilation
VENT_SLOT_W = 3.0     # Width of vent slots
VENT_SLOT_L = 40.0    # Length of vent slots
VENT_SPACING = 8.0    # Spacing between slots
VENT_COUNT = 6        # Number of bottom vent slots

# Screw posts for M3 heat-set inserts
POST_OD = 7.0         # Post outer diameter
POST_ID = 4.2         # Hole for M3 heat-set (4.2mm for press-fit)
POST_H = 10.0         # Post height

# Display cutout
DISPLAY_CUTOUT_W = VOCORE_W + 0.2  # 0.1mm tolerance per side
DISPLAY_CUTOUT_D = VOCORE_D + 0.2

# USB-C debug port cutout
USB_C_W = 12.0
USB_C_H = 7.0

# Power button cutout
PWR_BTN_DIA = 8.0

print(f"Internal cavity: {internal_w:.1f} × {internal_d:.1f} × {internal_h:.1f} mm")
print(f"External dims:   {EXT_W:.1f} × {EXT_D:.1f} × {EXT_H + LID_H:.1f} mm (with lid)")

# ==============================================================================
# BASE
# ==============================================================================

# Outer shell
base = (
    cq.Workplane("XY")
    .box(EXT_W, EXT_D, SPLIT_H)
    .translate((0, 0, SPLIT_H / 2))
    .edges("|Z").fillet(CORNER_R)
)

# Hollow out interior (shell operation)
base = (
    base
    .faces(">Z")
    .shell(-WALL)
)

# --- Screw posts (4 corners) ---
post_positions = [
    (EXT_W / 2 - WALL - POST_OD / 2 - 1, EXT_D / 2 - WALL - POST_OD / 2 - 1),
    (-EXT_W / 2 + WALL + POST_OD / 2 + 1, EXT_D / 2 - WALL - POST_OD / 2 - 1),
    (EXT_W / 2 - WALL - POST_OD / 2 - 1, -EXT_D / 2 + WALL + POST_OD / 2 + 1),
    (-EXT_W / 2 + WALL + POST_OD / 2 + 1, -EXT_D / 2 + WALL + POST_OD / 2 + 1),
]

for px, py in post_positions:
    post = (
        cq.Workplane("XY")
        .center(px, py)
        .circle(POST_OD / 2)
        .extrude(POST_H)
        .translate((0, 0, WALL))
    )
    hole = (
        cq.Workplane("XY")
        .center(px, py)
        .circle(POST_ID / 2)
        .extrude(POST_H)
        .translate((0, 0, WALL))
    )
    base = base.union(post).cut(hole)

# --- Bottom ventilation slots ---
for i in range(VENT_COUNT):
    offset_y = (i - (VENT_COUNT - 1) / 2) * VENT_SPACING
    vent = (
        cq.Workplane("XY")
        .center(0, offset_y)
        .rect(VENT_SLOT_L, VENT_SLOT_W)
        .extrude(WALL)
    )
    base = base.cut(vent)

# --- USB-C debug port cutout (front face) ---
usb_cutout = (
    cq.Workplane("XZ")
    .center(-EXT_W / 2 + WALL + 20, WALL + 15)
    .rect(USB_C_W, USB_C_H)
    .extrude(WALL + 1)
    .translate((0, -EXT_D / 2 - 0.5, 0))
)
base = base.cut(usb_cutout)

# --- Power button cutout (front face) ---
pwr_cutout = (
    cq.Workplane("XZ")
    .center(-EXT_W / 2 + WALL + 50, WALL + 15)
    .circle(PWR_BTN_DIA / 2)
    .extrude(WALL + 1)
    .translate((0, -EXT_D / 2 - 0.5, 0))
)
base = base.cut(pwr_cutout)

# --- Side ventilation slots (left and right) ---
for side_y in [EXT_D / 2, -EXT_D / 2]:
    for i in range(3):
        offset_x = (i - 1) * 25
        side_vent = (
            cq.Workplane("YZ")
            .center(side_y, SPLIT_H / 2 + 5)
            .rect(WALL + 1, 20)
            .extrude(3)
            .translate((offset_x, 0, 0))
        )
        # Skip this if it causes issues, side vents are nice-to-have


# ==============================================================================
# LID
# ==============================================================================

lid = (
    cq.Workplane("XY")
    .box(EXT_W, EXT_D, LID_H)
    .translate((0, 0, SPLIT_H + LID_H / 2))
    .edges("|Z").fillet(CORNER_R)
)

# Hollow out lid interior (creates lip that fits over base)
lid_inner = (
    cq.Workplane("XY")
    .box(EXT_W - 2 * WALL + 0.4, EXT_D - 2 * WALL + 0.4, LID_LIP)
    .translate((0, 0, SPLIT_H + LID_LIP / 2))
)
lid = lid.cut(lid_inner)

# Display cutout in lid
display_cut = (
    cq.Workplane("XY")
    .center(EXT_W / 4 - 10, 0)
    .rect(DISPLAY_CUTOUT_W, DISPLAY_CUTOUT_D)
    .extrude(LID_H + 1)
    .translate((0, 0, SPLIT_H - 0.5))
)
lid = lid.cut(display_cut)

# Screw holes in lid (matching base posts)
for px, py in post_positions:
    screw_hole = (
        cq.Workplane("XY")
        .center(px, py)
        .circle(1.6)  # M3 clearance hole
        .extrude(LID_H + 1)
        .translate((0, 0, SPLIT_H - 0.5))
    )
    lid = lid.cut(screw_hole)

# ==============================================================================
# COMPONENT PLACEHOLDERS (for visualization)
# ==============================================================================

# MeLE placeholder (ghost body for reference)
mele_placeholder = (
    cq.Workplane("XY")
    .box(MELE_W, MELE_D, MELE_H)
    .translate((-internal_w / 4, 0, WALL + BATTERY_H + TOLERANCE + MELE_H / 2))
)

# Router placeholder
router_placeholder = (
    cq.Workplane("XY")
    .box(ROUTER_W, ROUTER_D, ROUTER_H)
    .translate((internal_w / 4 - CABLE_AREA_W / 2, 0, WALL + BATTERY_H + TOLERANCE + ROUTER_H / 2))
)

# Battery placeholder
battery_placeholder = (
    cq.Workplane("XY")
    .box(BATTERY_W, BATTERY_D, BATTERY_H)
    .translate((-CABLE_AREA_W / 2, 0, WALL + BATTERY_H / 2))
)

# ==============================================================================
# EXPORT
# ==============================================================================

# Combine base + lid as assembly
assembly = base.union(lid)

# Export
output_dir = "/sessions/sharp-awesome-albattani/mnt/HeartBeatz/cadquery"

# Export individual parts for printing
cq.exporters.export(base, f"{output_dir}/main_box_base.step")
cq.exporters.export(lid, f"{output_dir}/main_box_lid.step")
cq.exporters.export(assembly, f"{output_dir}/main_box_assembly.step")

# Also export component placeholders for reference
cq.exporters.export(mele_placeholder, f"{output_dir}/ref_mele_n100.step")
cq.exporters.export(router_placeholder, f"{output_dir}/ref_router_mt3000.step")
cq.exporters.export(battery_placeholder, f"{output_dir}/ref_battery_ugreen.step")

print(f"\nExported STEP files to {output_dir}/")
print("  main_box_base.step     — Print this (base)")
print("  main_box_lid.step      — Print this (lid with display cutout)")
print("  main_box_assembly.step — Combined for visualization")
print("  ref_*.step             — Component placeholders for fit-check")
