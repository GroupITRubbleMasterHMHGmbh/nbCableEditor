# NetBox Rack Cable Editor

Design device faces and manage rack cabling directly in NetBox. Place ports on device images or custom drawings, connect and move cables in the rack view, and trace links through patch panels to wall outlets and endpoints.

Version **0.10.32** supports **NetBox 4.5.10 and later 4.5 releases** and requires **Python 3.12 or later** in the NetBox environment.

- [Installation and upgrades](docs/installation.md)
- [Local Docker demo](#local-docker-demo)

![Rack view focused on the cables connected to the patch panel](docs/screenshots/rack-cable-focus.png)

The device cable filter shows the patch panel's direct connections and dims occupied ports on unrelated links.

## Design device and module layouts

1. Create the port templates on a NetBox **Device Type** or **Module Type**. Use **Front Port Templates** and **Rear Port Templates** for passive jacks.
2. Open **Layout editor** and choose **Front** or **Rear**. Use **Use type image** to control the background on each face. Add custom artwork with **Text** or **Rectangle**. Rectangles support an optional fill and a label embedded in the frame, with corner, edge, vertical, and centered positions. Set the font family, size, and color for each text item.
3. Use **Single port** to place an individual port. With **Port grid**, choose a port range, set rows, columns, and numbering order, then drag the grid on the drawing. A 48-port switch can use 2 rows and 24 columns. Edit port labels individually or apply numbering to a group.
4. Use **Field → Insert** to add a standard field or an accessible NetBox custom field to a text item or rectangle label. The layout preview uses sample values. The rack shows the actual values the user has permission to see.
5. Use **Module bay** to draw a region for a NetBox module bay template. The rack shows the installed module's artwork and ports within that region. For module type images, add NetBox image attachments named `Front` and `Rear`.
6. Select **Save layout**. The layout applies to all instances of the type. Ports without a position remain available in the **Interface directory**.

Use **Select** to draw a selection box. Hold **Shift** while dragging to extend the selection, or use **Ctrl**/**⌘**-click to toggle individual ports. Move the selection together or use **Align** to arrange it in a row, column, or grid. Enable **Grid** or **Objects** under **Snap** for alignment guides. Hold **Alt** to bypass snapping while dragging. **Undo** and **Redo** cover the current editing session on both faces.

![Device layout editor showing the switch's 48 ports in two rows](docs/screenshots/port-layout.png)

## Work with cables in a rack

Open a rack in NetBox and select **Cable editor**. Use **View** to switch between **Front**, **Rear**, and **Both**, control device image opacity, and select the zoom and routing strategy. **Zoom → Fit** scales the drawing to the available space. Free ports have two green lines, while connected ports have a closed amber outline. Port labels stay inside the outline and wrap when that allows larger text.

| Task | How to do it |
| --- | --- |
| Connect two ports | Drag from a free port to another free port. Set the cable type, color, label, and optional length with its unit. The dialog prefills the previous type and color. Press **Enter** to submit. |
| Move a cable end | Drag the connected port or the handle on the cable to a free port and confirm. The cable keeps its ID and metadata. |
| Inspect or edit a cable | Click a cable to see its endpoints, VLANs, port types, PoE, connection status, and trace. With change permission, edit color, length, label, description, tags, and comments in the dialog. Text fields save on blur or **Enter**, and comments save with **Ctrl+Enter**. Colors and tags save on selection. |
| Use cable and port actions | Right-click a cable or port to open its context menu. The menu shows the actions available for that item and your permissions. |
| Connect or unplug in batches | Use **Quick connect** to stage pairs or **Unplug** to stage removals. **Apply batch** saves the queued changes together. **Discard** clears the queue. |
| Restore an earlier state | Use **Undo** and **Redo** to step through your changes to the rack, or select a checkpoint in **History**. An edit to the same cable from another user or NetBox screen can prevent that cable from being restored. |
| Focus on one device | Click the filter icon beside a device name to show its direct connections. Click the **Cables** chip to clear the filter. Use **Devices** to choose which devices are visible and **Port rows** to hide individual rows. |
| Choose how cables are drawn | Use **View → Routing strategy** to choose **Balanced** or **PCB-style**. Both use space around and between devices. PCB-style uses rounded turns. Adjust the virtual gaps between devices with **+** and **−**. |
| Bundle cables | Use **View → Lines → Bundles** to group cables by device pair and rack face. Select a bundle to show its individual cables. **Show all bundles** returns to the overview. |
| Inspect ports and VLANs | Double-click a port or choose **Port details** in its context menu. View the port type, VLANs, PoE, status, and any connected endpoint. The dialog links to native NetBox objects and supports editing the NetBox label and tags with change permission. |
| Find usable ports | Use **View → Interfaces** to highlight free or used ports. Filter by a VLAN ID and choose **Any**, **Tagged**, or **Untagged**. In **Port fill → Untagged VLAN**, the fill represents the VLAN and the outline shows connection status. Color rules use the first match, then the VLAN's `editorColorHex` value or the optional fallback color. |
| Print or export | Select **Export** to create a PNG with a chosen longest edge, or choose **Print / Save as PDF** to set the paper size and orientation. The print layout gives cable routes more space and can include a compact cable list grouped by device pair, with reference numbers in the plan. |

Hover over a cable or a connected port to see its destination, even with **Selected only** enabled or when the other device is hidden. Hover over or select an entry in **Connections** to highlight its cable in the drawing. The **Interface directory** shows port status and the connected peer. Use **Fields** in either list to choose which details appear. The browser remembers view options, including zoom, panel visibility, and **Trim width to visible ports**.

### Trace patch panels and wall outlets

The editor works with native NetBox devices, ports, cables, and images. It stores layouts for device and module types and tracks personal cable history per rack. It edits direct, one-to-one cables between supported interfaces, front ports, and rear ports in the same rack. Traces follow native port mappings through patch panels to a wall outlet or endpoint outside the rack when the user has permission to view that path. Use NetBox for edits to inter-rack cables and complex cable profiles.

![Cable details tracing Switch A through a patch panel and wall outlet to an access point](docs/screenshots/cable-trace.png)

See the [permissions guide](docs/installation.md#permissions) for the required NetBox object permissions.

## Local Docker demo

The Compose stack mounts the plugin from the checkout and serves NetBox at [localhost:8096](http://localhost:8096/). The demo uses local development credentials. For concurrent demos from separate checkouts, assign each one its own Compose project name and host port.

From the repository root, start NetBox and follow its startup logs.

```sh
docker compose -f dev/compose.yaml up -d
docker compose -f dev/compose.yaml logs -f netbox
```

When the login page is available, press **Ctrl+C** to leave the log view. Collect the static files, create a local superuser, and load the sample rack.

```sh
docker compose -f dev/compose.yaml exec netbox /opt/netbox/venv/bin/python /opt/netbox/netbox/manage.py collectstatic --no-input
docker compose -f dev/compose.yaml exec netbox /opt/netbox/venv/bin/python /opt/netbox/netbox/manage.py createsuperuser
docker compose -f dev/compose.yaml exec netbox sh -c "/opt/netbox/venv/bin/python /opt/netbox/netbox/manage.py shell < /plugin/dev/demo.py"
```

Open **Lab Rack 01** in NetBox and select **Cable editor**. The rack contains two 48-port switches and **Patch Panel PP-01**. The wall outlets and endpoints are in **Demo Office**, outside the rack.

| Switch A | Patch panel jack | Wall outlet | Endpoint | VLAN on the switch port |
| --- | --- | --- | --- | --- |
| Ethernet36 | P01 | WD-01 | Workstation PC-01 | Untagged 50 |
| Ethernet38 | P02 | WD-02 | Printer PR-01 | Untagged 50 |
| Ethernet42 | P03 | WD-03 | Access Point AP-01 | Tagged 50, untagged 99 |
| Ethernet46 | P04 | WD-04 | Open outlet | Untagged 50 |

- Hover over one of these switch ports to trace it. In **Normal** mode, click the cable to open the complete route. Search for VLAN `50` with **Tagged** selected to highlight the access point's switch port.
- Jacks P05 and P06 are free in a fresh demo. Select **View → Both** to connect a free switch port to the rear of the patch panel. Use **Undo** to restore the previous state.

Use `docker compose -f dev/compose.yaml stop` to pause the demo and `docker compose -f dev/compose.yaml start` to resume. The stack does not configure a persistent media volume for container rebuilds.

## Run the tests

Run the plugin tests in the demo container and the JavaScript tests with local Node.js.

```sh
docker compose -f dev/compose.yaml exec netbox /opt/netbox/venv/bin/python /opt/netbox/netbox/manage.py test netbox_rack_editor
node --test tests/*.test.cjs
```
