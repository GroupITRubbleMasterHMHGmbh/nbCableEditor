---
name: create-template-for-device-type
description: Create or update image-free JSON layout templates for NetBox Device Types in nbCableEditor, including switches, passive patch panels, and chassis. Use for /createTemplateForDeviceType requests.
---

# Create a Device Type layout template

Read the [catalog authoring workflow](../../../docs/user-guide.md#add-a-built-in-template) and use the `device` kind. Use the existing layout for comparable hardware as a style reference.

- Verify a branded device's exact SKU, visible faces, connector numbering, and shared logical ports using manufacturer sources. Record sources in the asset. For generic devices, describe the schematic assumptions and use the specified connector count.
- Use numbered interface slots for switches. For a passive panel, use `front-port` and `rear-port` slots on the corresponding faces. Keep the same logical number for both sides of a pass-through and mirror the horizontal order when both rows represent the same adapters viewed from opposite sides.
- Use named `bays` for removable cards and power supplies. Set `moduleFace` to the face of the installed component visible from that side of the chassis. Keep the device's JSON portable across NetBox installations.
- Add the asset to the Device Type catalog, document its SKU and assumptions, and validate it using the shared workflow.
