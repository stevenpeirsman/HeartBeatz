"""
HeartBeatz Button Box — Start/Stop Button Enclosure
=====================================================
Simple box (tub + snap-on lid). Button mounts through the lid.
50mm internal depth for button body + cables.
No mounting tabs — just a clean box.

Designed for 3D printing (Bambu Lab H2D, 0.2mm PETG).
Exports STEP for import into Autodesk Fusion 360.
"""

import cadquery as cq

# ==============================================================================
# PARAMETRIC DIMENSIONS
# ==============================================================================

WALL = 2.0
CORNER_R = 2.0
FIT_GAP = 0.2

# Button: 16mm panel-mount momentary
BTN_HOLE_DIA = 16.4
BTN_NUT_FLAT = 18.8

# Internal cavity
CAVITY_W = BTN_NUT_FLAT + 10.0   # ~29mm
CAVITY_L = BTN_NUT_FLAT + 10.0   # ~29mm
CAVITY_H = 50.0                   # 50mm depth for body + cables

# External
EXT_W = CAVITY_W + 2 * WALL
EXT_L = CAVITY_L + 2 * WALL
TUB_H = CAVITY_H + WALL
LID_H = 3.0

# Cable exit
CABLE_SLOT_W = 8.0
CABLE_SLOT_H = 6.0

# Snap-fit lip
LIP_H = 2.0
LIP_T = 1.2

# ==============================================================================
# BASE (TUB)
# ==============================================================================

def make_base():
    base = (
        cq.Workplane("XY")
        .box(EXT_W, EXT_L, TUB_H, centered=(True, True, False))
        .edges("|Z").fillet(CORNER_R)
    )
    # Main cavity
    base = (
        base.faces(">Z").workplane()
        .rect(CAVITY_W, CAVITY_L)
        .cutBlind(-CAVITY_H)
    )
    # Widen top pocket for lid rim
    base = (
        base.faces(">Z").workplane()
        .rect(CAVITY_W + LIP_T * 2, CAVITY_L + LIP_T * 2)
        .cutBlind(-LIP_H)
    )
    # Cable exit slot near bottom
    cable_slot = (
        cq.Workplane("XZ")
        .transformed(offset=(0, -EXT_L / 2, WALL + 3))
        .rect(CABLE_SLOT_W, CABLE_SLOT_H)
        .extrude(-WALL - 1)
    )
    base = base.cut(cable_slot)
    return base

# ==============================================================================
# LID
# ==============================================================================

def make_lid():
    lid = (
        cq.Workplane("XY")
        .box(EXT_W, EXT_L, LID_H, centered=(True, True, False))
        .edges("|Z").fillet(CORNER_R)
    )
    # Button hole
    lid = lid.faces(">Z").workplane().circle(BTN_HOLE_DIA / 2).cutThruAll()

    # Snap-fit rim that drops into the widened pocket at top of tub.
    # Pocket = (CAVITY + 2*LIP_T) wide, LIP_H deep.
    # Rim outer fills the pocket, rim inner clears the main cavity.
    rim_h = LIP_H - 0.3   # Slightly shorter than pocket depth so lid sits flush
    rim_ow = CAVITY_W + LIP_T * 2 - FIT_GAP * 2  # Fills the pocket
    rim_ol = CAVITY_L + LIP_T * 2 - FIT_GAP * 2
    rim_iw = CAVITY_W - FIT_GAP * 2               # Inner lines up with cavity wall
    rim_il = CAVITY_L - FIT_GAP * 2

    rim = cq.Workplane("XY").transformed(offset=(0, 0, -rim_h)).rect(rim_ow, rim_ol).extrude(rim_h)
    rim_cut = cq.Workplane("XY").transformed(offset=(0, 0, -rim_h)).rect(rim_iw, rim_il).extrude(rim_h)
    lid = lid.union(rim).cut(rim_cut)
    return lid

# ==============================================================================
# EXPORT
# ==============================================================================

if __name__ == "__main__":
    import os
    base = make_base()
    lid = make_lid()
    assembly = base.union(lid.translate((0, 0, TUB_H)))
    out = os.path.dirname(os.path.abspath(__file__))
    cq.exporters.export(base, os.path.join(out, "button_box_base.step"))
    cq.exporters.export(lid, os.path.join(out, "button_box_lid.step"))
    cq.exporters.export(assembly, os.path.join(out, "button_box_assembly.step"))
    print(f"Button Box: {EXT_W:.1f} x {EXT_L:.1f} x {TUB_H + LID_H:.1f} mm (50mm internal depth)")
