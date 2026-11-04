# Rack Cable Editor user guide

Use the rack editor to find available ports, follow connections, and plan or record changes in NetBox. This guide uses **Lab Rack 01** from the [local Docker demo](../README.md#local-docker-demo). The same controls apply to other racks.

- [Open the editor](#open-the-editor)
- [Filter devices, rows, and cables](#filter-devices-rows-and-cables)
- [Choose the rack view](#choose-the-rack-view)
- [Find ports by VLAN](#find-ports-by-vlan)
- [Inspect and change connections](#inspect-and-change-connections)
- [Export the rack plan](#export-the-rack-plan)
- [Design a device or module layout](#design-a-device-or-module-layout)
- [Saved settings and troubleshooting](#saved-settings-and-troubleshooting)

## Open the editor

1. Open a rack in NetBox and select **Cable editor**.
2. Start with **View → Rack side → Front** and **Zoom → Fit** to see the front elevation at the available width. Select **Rear** for rear-mounted ports or **Both** to work across the two sides.
3. Hover a port to identify it. Green double lines indicate a free port, an amber frame indicates a connected port, and a gray frame indicates an unavailable port. A VLAN fill can change the color inside the frame.

Available devices, ports, and actions depend on your [NetBox permissions](installation.md#permissions). A device can appear in the **Interface directory** even when its ports have no positions on the elevation.

## Filter devices, rows, and cables

| Control | What it changes | How to clear it |
| --- | --- | --- |
| **Devices** | Tick one or more devices to show those devices and their ports. With no device selected, the rack shows all devices. | Select **Show all**. |
| **Port rows** | Tick rows to show their ports on the elevation. The menu groups rows by device and rack side. **Only** keeps that row visible for its device and side. | Tick individual rows again or select **All rows**. |
| Filter icon beside a device name | Focuses cable display on direct connections to or from that device. Unrelated occupied ports are dimmed so the matching endpoints and free ports stand out. | Select the **Cables** chip in the toolbar. |
| **VLAN** | Highlights matching ports on the rack and narrows the side lists to VLAN matches. | Select **Clear** beside the VLAN selector. |
| **Interface directory → Search devices or interfaces** | Narrows the directory by device, port name, label, description, or cable peer. **Only ports outside the elevations** narrows it to ports that have no marker in the current elevations. | Clear the search and uncheck the option. |

![Devices filter with a subset of the demo devices selected](screenshots/user-guide-device-filter.png)

**To inspect the PP-01 patch panel**, click its filter icon while keeping its peer devices visible. Use **Devices** to narrow the drawing further, then hover a connected port to identify the peer. A peer outside the current view can still appear in the tooltip when its details are available.

![Cable focus on the patch panel and its direct connections](screenshots/rack-cable-focus.png)

Device cable focus shows all matching cables in the current view or shows them as bundles. Clear the **Cables** chip to choose **Selected only** or **Hidden** again. To find a missing port, check the rack side, **Devices**, and **Port rows** first. Use the directory to find ports without a placed marker.

## Choose the rack view

Open **View** in the rack toolbar. The following defaults apply in a fresh browser profile.

| Setting | Default | When to change it |
| --- | --- | --- |
| **Rack side** | **Front** | Choose **Rear** for rear patch ports or **Both** to see both elevations side by side. |
| **Lines** | **All** | Choose **Bundles** for an overview by device pair, **Selected only** to trace one chosen connection, or **Hidden** to hide persistent cable lines. Hover still lets you inspect a visible connected port. |
| **Routing strategy** | **Balanced** | Choose **PCB-style** for wider lanes and rounded turns. Expanded cable bundles use PCB-style automatically. |
| **Device images** | **Visible** | Use **50% opacity** or **Hidden** when the image makes ports or cables hard to see. Ports remain interactive. Press **I** while dragging a cable to cycle the image mode. |
| **Zoom** | **Fit** | Fit scales the drawing and ports to the available width. Use **100%**, **150%**, or **200%** for a fixed scale and scroll when needed. |
| **Port fill** | **Connection status** | Choose **Untagged VLAN** to color the port interior by VLAN and read connection status from the outline. |
| **Interfaces** | **All** | Choose **Highlight Free** or **Highlight Used** to emphasize ports by connection status. |
| **Connections** and **Interface directory** | Both visible | Hide either panel in **View** to simplify the workspace. Hide both for more drawing space. |
| **Trim width to visible ports** | Off | Crop the unused left and right margins to a shared width based on the visible port positions. Works with **Fit**. |
| **Virtual combine** | Off | Try narrow sleeves for runs of at least three cables between adjacent ports connected in the same order. |

![View menu with rack side, lines, routing, zoom, and port display settings](screenshots/user-guide-view.png)

### Read dense wiring

- Choose **Lines → Bundles** to see cable counts grouped by device pair and rack side. Select a bundle in the drawing or in the **Cable bundles** panel to expand it. Select **Show all bundles** to return to the overview.
- Use the small **+** and **−** controls between devices to adjust the display gap and make room for cable lanes. The rack positions in NetBox stay the same.
- Enable **Virtual combine** to try sleeves along eligible vertical or horizontal runs. The router searches for a clear stretch with space around other cables. Hover a sleeve to reveal all member cables inside its outline. Hover an individual cable or connected port to follow that link.

![Front and rear elevations in Both view, with device-pair bundles and cable counts](screenshots/user-guide-bundles.png)

## Find ports by VLAN

1. Enter a VLAN ID from **1** to **4094** in the toolbar, for example `50`.
2. Choose **Any**, **Tagged**, or **Untagged**. Tagged matches VLANs explicitly assigned to the port. The drawing marks matching ports, **Interface directory** lists those ports, and **Connections** lists cables with a matching endpoint in scope. In **All** line mode, the ordinary cable lines stay visible.
3. To find a place to connect a client, choose **Untagged** and look for a free, enabled match. The status beside the filter shows the count. **View → Interfaces → Highlight Free** makes free ports easier to pick out.
4. Hover or double-click a candidate to check its VLAN assignments, interface type, and PoE details. The editor displays the assignments recorded in NetBox.

![VLAN 50 filter highlighting matching ports in the rack](screenshots/user-guide-vlan.png)

### Set VLAN colors

Use **View → Port fill → Untagged VLAN**, then **Configure VLAN colors…**. Add a rule with a single ID, a comma-separated list such as `50,60,70`, or a range such as `50-70`. Choose the color and save. The first matching rule wins, followed by the VLAN's [Rack editor color](installation.md#configure-vlan-colors) and then the optional fallback. Ports without an untagged VLAN use a neutral fill.

VLAN color rules affect the port fill in your browser. Use the VLAN search to highlight tagged membership. To change a port's VLAN assignment, edit the interface in NetBox.

## Inspect and change connections

### Follow a port or cable

Hover a connected port to read **From → Destination**, with the hovered port first. When you hover a cable, its nearer end comes first. Both cards show the enlarged port label and keep their physical **End A** and **End B** identifiers. When the path continues through a patch panel, the arrow shows the immediate peer and the trace below shows the further destination, if visible to your account.

![Cable tooltip showing the nearer port, arrow, and destination port](screenshots/user-guide-cable-hover.png)

- Click or hover a **Connections** entry to highlight its cable in the drawing. The list shows endpoints and color. Use **Fields** to add details such as VLANs, type, status, and length.
- Use **Interface directory** for ports on or outside the elevations. It shows the connected peer and cable color when available. Use **Fields** to add peer VLANs, label, type, or description.
- Double-click a port or use **Port details** from its context menu to see port metadata and links to the native NetBox port, device, and connection. With change permission, you can edit the label and tags.
- Click a cable to open its details. A trace can follow NetBox front-to-rear mappings through a patch panel and a wall outlet. A stop marked **Unpatched** indicates an open end. With change permission, edit cable color, length, label, description, tags, and comments in the dialog. Text fields save on blur or **Enter**, comments save with **Ctrl+Enter**, and color and tag changes save when selected.
- Use the cable's right-click menu and choose **Edit cable…** to change its type or status.

![Cable details with a trace through a patch panel and wall outlet to an access point](screenshots/cable-trace.png)

### Connect, move, or remove cables

| Task | Steps |
| --- | --- |
| Connect two ports | In **Normal** mode, drag from a free port to a free target. Choose cable type, color, label, and optionally a length and unit. The dialog prefills the last saved type and color. Press **Enter** to confirm. |
| Connect outside the view | Double-click a free port and choose **Manual Connect**. NetBox opens its native cable form with side A preselected. Search for the destination on side B, including devices outside the rack, then save or cancel to return to the editor. |
| Move one end | Drag the connected port or its cable handle onto a free target and confirm. The existing cable keeps its ID and metadata. |
| Remove a connection | Open the cable details and choose **Remove cable…**, or use the cable's right-click menu. |
| Change several connections | Select **Quick connect** and click a source followed by a highlighted target to stage each pair, or select **Unplug** and click connected ports to stage removals. Choose **Apply batch** to save or **Discard** to clear the queue. |
| Restore earlier changes | Use **Undo**, **Redo**, or choose a checkpoint in **History**. History covers cable changes saved through the rack editor and is scoped to your account and rack. A concurrent change to the same cable can prevent a restore. |

The editor draws and directly edits one-to-one cables between interfaces, front ports, and rear ports in the same rack. NetBox permissions govern which actions are available.

## Export the rack plan

1. Set the rack sides, devices, rows, and line mode you want to include. If you want individual links in the plan, choose **All** or expand the bundle before exporting.
2. Select **Export**. For **PNG image**, choose the longest side or enter a custom value from 320 to 6000 pixels. The whole drawing is exported at its current aspect ratio.
3. For **Print / Save as PDF**, choose paper size and orientation. Enable **Include cable list** to list the drawn cables or bundles that match the current **Connections** filters. The list is grouped by endpoint devices, with reference numbers linking the rows to the plan. Choose your printer or **Save as PDF** in the browser print dialog.

The print layout spaces routes more widely than the on-screen drawing. Use the preview to check that the rack and cable list fit the chosen page size.

## Design a device or module layout

1. Create the port templates on the NetBox **Device Type** or **Module Type**. Use **Front Port Templates** and **Rear Port Templates** for passive jacks. Open **Layout editor** and choose **Front** or **Rear**.
2. Use **Use type image** to choose the background on each face. Add custom artwork with **Text** or **Rectangle**. Set font, size, and color. A rectangle can have a fill and a label integrated in its frame or centered within it.
3. Use **Single port** to place one port. For a range, select **Port grid**, choose the **First port** and **Last port**, then set the row and column counts, **Port order**, and labels. Drag the grid onto the drawing or use **Place centered**. For example, 48 ports can use 2 rows and 24 columns. **Displayed port label** sets the rack label for all instances of the type.
4. Use **Field → Insert** to add a device, module, or accessible custom field to a text item or rectangle label. The preview uses sample values. The rack renders the actual values available to the viewer.
5. Draw a **Module bay** region for a bay template on a device type. An installed module's artwork and ports appear in that region. For module type images, add NetBox image attachments named `Front` and `Rear`.
6. Choose **Save layout** to apply the design to instances of that type. Unplaced ports remain accessible from the directory.

Use **Select** to drag a selection box. Hold **Shift** to extend the selection or **Ctrl**/**⌘**-click to toggle individual ports. Use **Align** for a row, column, or grid, and **Snap → Grid** or **Objects** for alignment guides. Hold **Alt** while dragging to bypass snapping. **Undo** and **Redo** cover both faces of the current editing session.

![Layout editor showing ports positioned in two rows on a 48-port switch](screenshots/port-layout.png)

## Saved settings and troubleshooting

- **Shared across racks in this browser.** Zoom, line mode, routing strategy, images, panel visibility and open state, list fields, VLAN color rules, trim, and other display options use browser storage.
- **Saved separately for each rack.** Rack side, selected devices and rows, device cable focus, VLAN filter, directory search, and display gaps use browser storage. The URL carries the active side, device, row, cable-focus, and VLAN filters so you can copy a link to that selection. The recipient's own display settings still apply.
- **A cable is missing.** Clear the **Cables** chip and VLAN filter, restore the devices and rows, select the relevant rack side, and choose **View → Lines → All**. Check the **Connections** list for a peer outside the elevation.
- **A device image or port is missing.** Select **Device images → Visible**, check the rack side and port rows, then inspect the device or module type's layout. A port without coordinates can still be found in the directory.
- **An edit action is unavailable.** Ask your NetBox administrator to verify the required [object permissions](installation.md#permissions) for the affected cables, devices, ports, or layouts.
