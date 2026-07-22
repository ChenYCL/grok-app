/**
 * Rich local document preview:
 * - PDF  → react-pdf (pdf.js)
 * - DOCX → docx-preview (styled Word layout)
 * - XLSX → SheetJS (xlsx) multi-sheet tables
 * - PPTX → limited text fallback + open externally
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { renderAsync } from "docx-preview";
import * as XLSX from "xlsx";
import { fetchPreviewArrayBuffer } from "@/lib/filePreviewSrc";
import { createT, type Locale } from "@/i18n";
import { openInEditor, pathOpen, pathReveal } from "@/lib/api";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface OfficeDocumentPreviewProps {
  kind: string;
  absolutePath: string;
  name: string;
  locale: Locale;
  /** Plain-text extract from host (pptx / fallback). */
  textFallback?: string | null;
  errorFromHost?: string | null;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; buffer: ArrayBuffer };

export function OfficeDocumentPreview({
  kind,
  absolutePath,
  name,
  locale,
  textFallback,
  errorFromHost,
}: OfficeDocumentPreviewProps) {
  const tr = useMemo(() => createT(locale), [locale]);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [pdfPages, setPdfPages] = useState(0);
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfScale, setPdfScale] = useState(1.05);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [sheetHtml, setSheetHtml] = useState("");
  const docxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    setPdfPages(0);
    setPdfPage(1);
    setSheetNames([]);
    setActiveSheet(0);
    setSheetHtml("");

    if (errorFromHost && !absolutePath) {
      setLoad({ status: "error", message: errorFromHost });
      return;
    }

    // pptx: no mature free browser renderer — prefer text + open
    if (kind === "pptx" || kind === "odf") {
      setLoad({
        status: "error",
        message: tr("office.pptxLimited"),
      });
      return;
    }

    void (async () => {
      try {
        const buf = await fetchPreviewArrayBuffer(absolutePath, kind);
        if (cancelled) return;
        setLoad({ status: "ready", buffer: buf });
      } catch (e) {
        if (cancelled) return;
        setLoad({
          status: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [absolutePath, kind, errorFromHost, tr]);

  // DOCX render
  useEffect(() => {
    if (load.status !== "ready") return;
    if (kind !== "docx" && kind !== "office") return;
    const el = docxRef.current;
    if (!el) return;
    el.innerHTML = "";
    let cancelled = false;
    void renderAsync(load.buffer, el, undefined, {
      className: "office-docx-body",
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      breakPages: true,
      useBase64URL: true,
    }).catch((e) => {
      if (!cancelled) {
        setLoad({
          status: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [load, kind]);

  // XLSX parse
  useEffect(() => {
    if (load.status !== "ready") return;
    if (kind !== "xlsx") return;
    try {
      const wb = XLSX.read(load.buffer, { type: "array" });
      const names = wb.SheetNames;
      setSheetNames(names);
      const idx = 0;
      setActiveSheet(idx);
      const ws = wb.Sheets[names[idx]];
      setSheetHtml(ws ? XLSX.utils.sheet_to_html(ws, { id: "office-sheet" }) : "");
    } catch (e) {
      setLoad({
        status: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [load, kind]);

  const switchSheet = (idx: number) => {
    if (load.status !== "ready" || kind !== "xlsx") return;
    try {
      const wb = XLSX.read(load.buffer, { type: "array" });
      const name = wb.SheetNames[idx];
      const ws = wb.Sheets[name];
      setActiveSheet(idx);
      setSheetHtml(ws ? XLSX.utils.sheet_to_html(ws, { id: "office-sheet" }) : "");
    } catch (e) {
      setLoad({
        status: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const openExternal = async () => {
    try {
      await pathOpen(absolutePath);
    } catch {
      try {
        await openInEditor({ path: absolutePath });
      } catch {
        await pathReveal(absolutePath);
      }
    }
  };

  if (load.status === "loading") {
    return (
      <div className="office-preview office-preview--center">
        <div className="office-preview__status">{tr("office.loading")}</div>
        <div className="office-preview__sub">{name}</div>
      </div>
    );
  }

  if (load.status === "error") {
    return (
      <div className="office-preview office-preview--center">
        <div className="office-preview__status">{tr("office.renderFailed")}</div>
        <div className="office-preview__sub">{load.message}</div>
        {textFallback ? (
          <pre className="office-preview__fallback">{textFallback}</pre>
        ) : null}
        <div className="office-preview__actions">
          <button type="button" className="btn btn--solid" onClick={() => void openExternal()}>
            {tr("office.openExternal")}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => void pathReveal(absolutePath)}>
            {tr("resources.revealFolder")}
          </button>
        </div>
      </div>
    );
  }

  // PDF
  if (kind === "pdf") {
    return (
      <div className="office-preview office-preview--pdf">
        <div className="office-preview__bar">
          <span className="office-preview__bar-title" title={name}>
            {name}
          </span>
          <div className="office-preview__bar-actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={pdfPage <= 1}
              onClick={() => setPdfPage((p) => Math.max(1, p - 1))}
            >
              {tr("office.prevPage")}
            </button>
            <span className="office-preview__page">
              {pdfPages
                ? tr("office.pageOf", { page: pdfPage, total: pdfPages })
                : "—"}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={!pdfPages || pdfPage >= pdfPages}
              onClick={() =>
                setPdfPage((p) => (pdfPages ? Math.min(pdfPages, p + 1) : p))
              }
            >
              {tr("office.nextPage")}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setPdfScale((s) => Math.max(0.6, s - 0.1))}
            >
              −
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setPdfScale((s) => Math.min(2.2, s + 0.1))}
            >
              +
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void openExternal()}
            >
              {tr("office.openExternal")}
            </button>
          </div>
        </div>
        <div className="office-preview__pdf-scroll">
          <Document
            file={{ data: new Uint8Array(load.buffer) }}
            onLoadSuccess={(d) => {
              setPdfPages(d.numPages);
              setPdfPage(1);
            }}
            loading={
              <div className="office-preview__status">{tr("office.loading")}</div>
            }
            error={
              <div className="office-preview__status">
                {tr("office.renderFailed")}
              </div>
            }
          >
            <Page
              pageNumber={pdfPage}
              scale={pdfScale}
              renderTextLayer
              renderAnnotationLayer
            />
          </Document>
        </div>
      </div>
    );
  }

  // DOCX
  if (kind === "docx" || kind === "office") {
    return (
      <div className="office-preview office-preview--docx">
        <div className="office-preview__bar">
          <span className="office-preview__bar-title" title={name}>
            {name}
          </span>
          <div className="office-preview__bar-actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void openExternal()}
            >
              {tr("office.openExternal")}
            </button>
          </div>
        </div>
        <div className="office-preview__docx-scroll">
          <div ref={docxRef} className="office-docx-host" />
        </div>
      </div>
    );
  }

  // XLSX
  if (kind === "xlsx") {
    return (
      <div className="office-preview office-preview--xlsx">
        <div className="office-preview__bar">
          <span className="office-preview__bar-title" title={name}>
            {name}
          </span>
          <div className="office-preview__bar-actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void openExternal()}
            >
              {tr("office.openExternal")}
            </button>
          </div>
        </div>
        {sheetNames.length > 1 && (
          <div className="office-preview__sheets" role="tablist">
            {sheetNames.map((sn, i) => (
              <button
                key={sn}
                type="button"
                role="tab"
                className={
                  "office-preview__sheet-tab" +
                  (i === activeSheet ? " is-active" : "")
                }
                onClick={() => switchSheet(i)}
              >
                {sn}
              </button>
            ))}
          </div>
        )}
        <div
          className="office-preview__sheet-scroll"
          dangerouslySetInnerHTML={{ __html: sheetHtml }}
        />
      </div>
    );
  }

  return (
    <div className="office-preview office-preview--center">
      <div className="office-preview__status">{tr("office.unsupported")}</div>
      <button type="button" className="btn btn--solid" onClick={() => void openExternal()}>
        {tr("office.openExternal")}
      </button>
    </div>
  );
}
