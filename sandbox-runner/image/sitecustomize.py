"""Loaded by Python before every analysis run (it's on PYTHONPATH): Arabic that just works in charts.

matplotlib draws text left to right, glyph by glyph: Arabic comes out with its letters unjoined and
in reverse order unless every label is shaped and reordered first (onespace.ar). Code written by
the model rarely does that, so this does it for all matplotlib text, once matplotlib is imported:

- an Arabic-capable font first (Noto Sans Arabic, with DejaVu Sans for Latin, per-glyph fallback);
- every text set on a figure (titles, axis labels, ticks, legends, annotations, pandas plots) that
  contains Arabic letters is shaped (arabic_reshaper) and put in visual order (python-bidi).

Text already passed through onespace.ar() holds presentation forms, not Arabic letters, so it isn't
processed twice. Nothing here touches files, the network or anything outside matplotlib.
"""

import importlib.abc
import importlib.machinery
import re
import sys

_ARABIC = re.compile(r"[؀-ۿݐ-ݿࢠ-ࣿ]")


def shape(s):
    if not isinstance(s, str) or not _ARABIC.search(s):
        return s
    try:
        import arabic_reshaper
        from bidi.algorithm import get_display

        return "\n".join(get_display(arabic_reshaper.reshape(line)) for line in s.split("\n"))
    except Exception:
        return s


def _patch_text(mod):
    Text = mod.Text
    if getattr(Text, "_onespace_arabic", False):
        return
    original = Text.set_text

    def set_text(self, s):
        return original(self, shape(s) if isinstance(s, str) else s)

    Text.set_text = set_text
    Text._onespace_arabic = True


def _setup_rc(mod):
    rc = mod.rcParams
    # Families named directly (not "sans-serif"): matplotlib then falls back glyph by glyph, so
    # Latin, digits and punctuation missing from the Arabic font come from DejaVu Sans.
    rc["font.family"] = ["Noto Sans Arabic", "DejaVu Sans"]
    rc["axes.unicode_minus"] = False


_AFTER = {"matplotlib": _setup_rc, "matplotlib.text": _patch_text}


class _Loader(importlib.abc.Loader):
    def __init__(self, inner, after):
        self.inner, self.after = inner, after

    def create_module(self, spec):
        return self.inner.create_module(spec)

    def exec_module(self, module):
        self.inner.exec_module(module)
        try:
            self.after(module)
        except Exception:
            pass


class _Finder(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        after = _AFTER.get(name)
        if after is None:
            return None
        spec = importlib.machinery.PathFinder.find_spec(name, path)
        if spec is None or spec.loader is None:
            return spec
        spec.loader = _Loader(spec.loader, after)
        return spec


sys.meta_path.insert(0, _Finder())
