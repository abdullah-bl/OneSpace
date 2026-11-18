# OneSpace analysis sandbox image: Python + pandas/numpy/matplotlib/openpyxl + Arabic fonts.
# Built once from official base images (needs internet at build time only). Runs are fully offline
# (--network none). Every version is pinned so a rebuild gives the same environment.
FROM python:3.12.7-slim-bookworm

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MPLBACKEND=Agg

# Arabic-capable fonts: Amiri (Naskh), KACST, DejaVu (sans with Arabic glyphs, matplotlib default).
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-hosny-amiri fonts-kacst fonts-dejavu-core fontconfig \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f

RUN pip install \
      numpy==2.1.3 \
      pandas==2.2.3 \
      matplotlib==3.9.2 \
      openpyxl==3.1.5 \
      arabic-reshaper==3.0.0 \
      python-bidi==0.6.3

# Pre-built matplotlib font cache (copied to the writable /tmp at run start; the rootfs is read-only).
RUN mkdir -p /opt/mplconfig \
 && MPLCONFIGDIR=/opt/mplconfig python -c "import matplotlib.font_manager as fm; fm._load_fontmanager(try_read_cache=False)" \
 && chmod -R a+rX /opt/mplconfig

# Unprivileged user with no home and no shell.
RUN groupadd -g 10001 sandbox && useradd -u 10001 -g 10001 -M -d /nonexistent -s /usr/sbin/nologin sandbox

COPY entry.py /opt/sandbox/entry.py
COPY helpers.py /opt/sandbox/lib/onespace.py
RUN chmod -R a+rX /opt/sandbox

USER 10001:10001
WORKDIR /tmp
ENTRYPOINT ["python", "-I", "-B", "/opt/sandbox/entry.py"]
