"""Small helpers available to analysis code as `import onespace`.

    import onespace
    onespace.arabic_plots()               # Arabic-capable font for matplotlib
    plt.title(onespace.ar("توزيع الدرجات"))  # shape + reorder Arabic text for matplotlib
"""

import os

INPUT = "/input"
OUTPUT = "/output"


def ar(text):
    """Arabic text shaped and ordered for renderers without bidi support (matplotlib)."""
    import arabic_reshaper
    from bidi.algorithm import get_display

    return get_display(arabic_reshaper.reshape(str(text)))


def arabic_plots(font="Noto Sans Arabic"):
    """Kept for older code: Arabic in charts is now set up automatically (sitecustomize.py)."""
    import matplotlib

    matplotlib.rcParams["font.family"] = [font, "DejaVu Sans"]
    matplotlib.rcParams["axes.unicode_minus"] = False


def inputs():
    """Names of the files exported to /input."""
    return sorted(os.listdir(INPUT))


def output_path(name):
    """A path under /output for a result file."""
    name = os.path.basename(name)
    return os.path.join(OUTPUT, name)
