---
name: create-template-for-module
description: Create or update image-free JSON layout templates for NetBox Module Types in nbCableEditor, including line cards and power supplies. Use for /createTemplateForModule requests.
---

# Create a Module Type layout template

Read the [catalog authoring workflow](../../../docs/user-guide.md#add-a-built-in-template) and use the `module` kind. Use the existing J9537A, J9548A, J9538A, and J9829A assets as references.

- Verify the exact SKU, card connector arrangement, and printed numbering using manufacturer sources. Put the sources in the asset. Use relative connector numbers so one layout works in every bay. The designer can map names such as `A1` or `Ethernet{module}/1` using the port name pattern.
- Draw the exposed connector face. Use `front` for a front-mounted line card and `rear` for a rear-mounted power supply. Use artwork for an AC inlet and an empty `ports` list when the component has no assignable network or passive ports.
- Check a matching chassis template's `moduleFace` when applicable. Keep the position of the bay in the chassis template and the connector positions inside the module template.
- Add the asset to the Module Type catalog, document the SKU and assumptions, and validate it using the shared workflow.
