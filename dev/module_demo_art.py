"""Draw the device and module face images for the local rack demo."""

from io import BytesIO

from django.core.files.base import ContentFile
from PIL import Image, ImageDraw, ImageFont


CHASSIS_SIZE = (1200, 216)
MODULE_SIZE = (300, 152)
BAY_BOXES = ((226, 36, 300, 152), (542, 36, 300, 152), (858, 36, 300, 152))
MODULE_PORT_CENTERS = ((56, 98), (119, 98), (182, 98), (245, 98))


def _png(image):
    output = BytesIO()
    image.save(output, format="PNG")
    return ContentFile(output.getvalue())


def chassis_artwork(face):
    image = Image.new("RGB", CHASSIS_SIZE, "#202d3d")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((3, 3, 1196, 212), radius=12, fill="#28384a", outline="#60778b", width=3)
    draw.text((25, 77), "MODULAR", fill="#e6f1f8", font=ImageFont.load_default(size=26))
    draw.text((25, 111), "DEMO CHASSIS", fill="#afc4d6", font=ImageFont.load_default(size=20))
    draw.text((25, 156), face.upper(), fill="#8ea7be", font=ImageFont.load_default(size=18))
    draw.ellipse((177, 116, 187, 126), fill="#66dc8e")
    label_font = ImageFont.load_default(size=17)
    for index, (left, top, width, height) in enumerate(BAY_BOXES, start=1):
        draw.rounded_rectangle(
            (left - 4, top - 4, left + width + 3, top + height + 3), radius=8,
            fill="#142131", outline="#6d8499", width=2,
        )
        draw.text((left + width / 2, 201), f"BAY {index}", anchor="mm", fill="#afc4d6", font=label_font)
    return _png(image)


def module_artwork(face, *, title, accent):
    image = Image.new("RGB", MODULE_SIZE, "#172535")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((2, 2, 297, 149), radius=8, fill="#25384b", outline="#6d8499", width=2)
    draw.rounded_rectangle((12, 12, 287, 42), radius=5, fill=accent)
    draw.text((150, 27), title, anchor="mm", fill="#f5fbff", font=ImageFont.load_default(size=20))
    draw.text((150, 59), face.upper(), anchor="mm", fill="#b6c9d9", font=ImageFont.load_default(size=15))
    jack_color = "#62778c" if face == "front" else "#8e7656"
    # The rack editor places the module and bay names along the bottom edge.
    for x, y in MODULE_PORT_CENTERS:
        draw.rounded_rectangle((x - 20, y - 16, x + 20, y + 16), radius=4,
                               fill="#111c29", outline="#93a6b8", width=2)
        draw.rectangle((x - 11, y - 7, x + 11, y + 9), fill=jack_color)
    return _png(image)
