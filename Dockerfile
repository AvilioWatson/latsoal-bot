FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8765 \
    PYTHON=python \
    LATSOAL_DATA_ROOT=/data \
    LATSOAL_RENDER_ENGINE=latex \
    LATSOAL_LATEX_COMMAND=pdflatex \
    LATSOAL_PDF_CONVERTER=pdftoppm \
    LATSOAL_RENDER_TIMEOUT_SECONDS=60

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        lmodern \
        poppler-utils \
        python-is-python3 \
        python3 \
        python3-cairosvg \
        python3-pil \
        texlive-latex-base \
        texlive-latex-recommended \
        texlive-pictures \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

COPY . .

RUN mkdir -p /data/outputs /data/saved /data/approved /data/bank

EXPOSE 8765

CMD ["node", "server.js"]
