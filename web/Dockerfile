# Runtime for serve.py. Only what serving needs: PyMuPDF to rasterise uploaded
# bill PDFs and openai to call the LLM endpoint. The pipeline's heavier
# dependencies (playwright + Chromium, pdfplumber) are deliberately absent —
# efl_compare.py runs on the host, not in here.
FROM python:3.12-slim

RUN pip install --no-cache-dir "PyMuPDF>=1.24" "openai>=1.40"

WORKDIR /app
