# OneSpace app: the OneBase server (functions in ./onebase) serving the built frontend (./dist).
# Data (SQLite, uploaded files, admin key) lives in /data: mount a volume there.

FROM oven/bun:1.4.4 AS build
# git: onebase and onebase-components are git dependencies pinned to commits (package.json).
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build && bunx onebase codegen

FROM oven/bun:1.4.4-slim
# System tools the server calls (run as child processes, not npm packages):
#   libreoffice-writer-nogui + calc-nogui: soffice --headless --convert-to (.doc/.odt/.rtf/.xls/.ods to
#     docx/xlsx, Word certificate templates to PDF). Add libreoffice-impress-nogui if .ppt/.pptx is needed.
#   poppler-utils: pdftotext/pdftoppm/pdfinfo (PDF text, OCR pages, previews).
#   unzip: reading .docx/.xlsx parts. fontconfig: fc-list for missing-font checks.
#   Arabic fonts for LibreOffice: Amiri (used by the sample certificate), Noto Naskh/Kufi/Sans Arabic, KACST.
#   fonts-liberation + fonts-crosextra-carlito: metric twins of Arial/Times and Calibri for Word templates.
#   fonts-noto-core covers every script (~42 MB); only its Latin and Arabic faces are kept.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui libreoffice-calc-nogui \
      poppler-utils unzip fontconfig \
      fonts-hosny-amiri fonts-noto-core fonts-kacst-one fonts-liberation fonts-crosextra-carlito \
    && find /usr/share/fonts/truetype/noto -type f \
         ! -name 'NotoSans-*' ! -name 'NotoSerif-*' ! -name 'NotoSansMono-*' \
         ! -name '*Arabic*' -delete \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man
WORKDIR /app
COPY --from=build --chown=bun:bun /app /app
RUN mkdir -p /data /shares && chown bun:bun /data
# SAL_DISABLE_CUPS: without it LibreOffice waits ~25 s per .docx import looking for a printer service.
ENV ONEBASE_DATA=/data PORT=8090 ONEBASE_HOST=0.0.0.0 NODE_ENV=production SAL_DISABLE_CUPS=1
EXPOSE 8090
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD bun -e "fetch('http://127.0.0.1:8090/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Starts as root only to prepare the data volume (Fly and some hosts mount volumes owned by root;
# an optional /data/restore.tgz is unpacked first), then runs the server as "bun".
CMD ["sh", "scripts/docker-start.sh"]
