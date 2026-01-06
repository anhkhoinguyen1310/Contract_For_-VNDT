// src/pages/PHIRedactionPage/hooks/usePHIRedaction.ts
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  MAX_PREVIEW_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  RedactionBox,
  RedactionMode,
  ServiceStatus,
  Point,
  SessionPayloadKind,
  SessionAction,
  TextSpan,
  TextRedactionStatePayload,
  KeepBox,
} from "../lib/types";
import { redactionAPI } from "../lib/redactionApi";
import {
  saveRedactedFileToStorage,
  saveRedactedPriorNoteToStorage,
} from "../../utils/redactedFiles";
import {
  clearRedactionSession,
  loadRedactionSession,
  saveRedactionSession,
  StoredRedactionSession,
  StoredTextSpanDraft,
} from "../lib/sessionPersistence";

/**
 * Central hook for PHI redaction UI.
 *
 * - Talks to local_redaction_service via redactionAPI
 * - Manages AI + manual boxes
 * - Provides undo/redo over redaction state
 * - Exposes canvas handlers for Canvas.tsx
 *
 * FIXES:
 * 1. Prevents re-running detection after apply-redactions completes
 * 2. Fetches preview image ONCE per page, then scales it with Canvas CSS transform
 */
export function usePHIRedaction() {
  const location = useLocation();
  const navigate = useNavigate();
  const didReloadRef = useRef<boolean>(
    (() => {
      try {
        if (typeof window === "undefined") return false;
        const entries = (performance.getEntriesByType?.("navigation") ??
          []) as PerformanceEntry[];
        const nav = entries[0] as PerformanceNavigationTiming | undefined;
        if (nav?.type) return nav.type === "reload";
        // eslint-disable-next-line deprecation/deprecation
        const legacyType = (performance as any).navigation?.type;
        return legacyType === 1;
      } catch {
        return false;
      }
    })()
  );

  // --- service + file state ---
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus>("checking");
  const [file, setFile] = useState<File | null>(null);
  const [textPayload, setTextPayload] = useState<{
    content: string;
    filename: string;
  } | null>(null);
  const [payloadType, setPayloadType] = useState<string>("lab");
  const [documentId, setDocumentId] = useState<string>("");
  const [sessionPayloadKind, setSessionPayloadKind] =
    useState<SessionPayloadKind>("pdf");
  const [textSpans, setTextSpans] = useState<TextSpan[]>([]);
  const [manualTextSpans, setManualTextSpans] = useState<TextSpan[]>([]);
  const [removedSpanIds, setRemovedSpanIds] = useState<Set<string>>(
    () => new Set()
  );
  const [removedManualSpanIds, setRemovedManualSpanIds] = useState<Set<string>>(
    () => new Set()
  );
  const [sourceText, setSourceText] = useState<string>("");
  const [redactedTextPreview, setRedactedTextPreview] = useState<string>("");

  // --- redaction state ---
  const [redactionBoxes, setRedactionBoxes] = useState<RedactionBox[]>([]);
  const [manualBoxes, setManualBoxes] = useState<RedactionBox[]>([]);
  const [canUndo, setCanUndo] = useState<boolean>(false);
  const [canRedo, setCanRedo] = useState<boolean>(false);
  const [whitelistAdditions, setWhitelistAdditions] = useState<string[]>([]);
  const [blacklistAdditions, setBlacklistAdditions] = useState<string[]>([]);

  const [currentPage, setCurrentPage] = useState<number>(0);
  const [totalPages, setTotalPages] = useState<number>(0);

  // Simplified preview state - fetch once per page at a fixed zoom
  const [pagePreview, setPagePreview] = useState<string>("");
  const [allPagePreviews, setAllPagePreviews] = useState<
    Record<number, string>
  >({});
  const [pagePreviewSizes, setPagePreviewSizes] = useState<
    Record<number, { width: number; height: number }>
  >({});

  const [zoom, setZoomState] = useState<number>(1);
  const [mode, setMode] = useState<RedactionMode>("edit");
  const [loading, setLoading] = useState<boolean>(false);
  const [stats, setStats] = useState<any>(null);

  // drawing helpers
  const [isDrawing, setIsDrawing] = useState<boolean>(false);
  const [drawStart, setDrawStart] = useState<Point | null>(null);
  const drawStartPxRef = useRef<Point | null>(null);
  const suppressNextClickRef = useRef(false);

  // canvas + input refs
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  //Keep Box
  const [keepBoxes, setKeepBoxes] = useState<KeepBox[]>([]);

  const getActiveKeepsForPage = useCallback(
    (pageIndex: number) => keepBoxes.filter((b) => b.page === pageIndex && !b.is_removed),
    [keepBoxes]
  );

  const isPointInActiveKeep = useCallback(
    (pageIndex: number, pdfX: number, pdfY: number) => {
      const activeKeeps = getActiveKeepsForPage(pageIndex);
      if (activeKeeps.length === 0) return true; // no crop constraint on this page
      return activeKeeps.some((b) => {
        const x0 = Math.min(b.x0, b.x1);
        const y0 = Math.min(b.y0, b.y1);
        const x1 = Math.max(b.x0, b.x1);
        const y1 = Math.max(b.y0, b.y1);
        return pdfX >= x0 && pdfX <= x1 && pdfY >= y0 && pdfY <= y1;
      });
    },
    [getActiveKeepsForPage]
  );

  const intersectRect = useCallback(
    (
      a: { x0: number; y0: number; x1: number; y1: number },
      b: { x0: number; y0: number; x1: number; y1: number }
    ) => {
      const ax0 = Math.min(a.x0, a.x1);
      const ay0 = Math.min(a.y0, a.y1);
      const ax1 = Math.max(a.x0, a.x1);
      const ay1 = Math.max(a.y0, a.y1);
      const bx0 = Math.min(b.x0, b.x1);
      const by0 = Math.min(b.y0, b.y1);
      const bx1 = Math.max(b.x0, b.x1);
      const by1 = Math.max(b.y0, b.y1);
      const x0 = Math.max(ax0, bx0);
      const y0 = Math.max(ay0, by0);
      const x1 = Math.min(ax1, bx1);
      const y1 = Math.min(ay1, by1);
      if (x1 <= x0 || y1 <= y0) return null;
      return { x0, y0, x1, y1 };
    },
    []
  );

  // --- session context ---
  const [sessionContext, setSessionContext] = useState<{
    roomNumber?: number;
    isAiPatientMode?: boolean;
  }>({});
  const hasAttemptedRestoreRef = useRef(false);
  const isRestoringRef = useRef(false);
  const restoredFromSessionRef = useRef(false);
  const lastDocumentIdRef = useRef<string | null>(null);
  const hasHydratedNavStateRef = useRef(false);

  // FIX #1: Track if we're in the middle of applying redactions
  const isApplyingRef = useRef(false);

  const clampZoom = (value: number) =>
    Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

  // FIX #2: Fetch preview at fixed zoom
  const PREVIEW_FETCH_ZOOM = MAX_PREVIEW_ZOOM; // Fetch at max quality (2.5x)

  const cleanupDocument = useCallback(async (id?: string | null) => {
    if (!id) return;
    try {
      await redactionAPI.cleanup?.(id);
    } catch (err) {
      console.warn("cleanup failed (non-fatal):", err);
    }
  }, []);

  const applyPdfSession = useCallback((response: any) => {
    setRedactionBoxes(response.redaction_boxes ?? []);
    setManualBoxes(response.manual_boxes ?? []);
    setKeepBoxes(response.keep_boxes ?? []);
    setStats(response.stats ?? null);
    setCanUndo(!!response.can_undo);
    setCanRedo(!!response.can_redo);
    setWhitelistAdditions(response.whitelist_additions ?? []);
    setBlacklistAdditions(response.blacklist_additions ?? []);
    if (typeof response.total_pages === "number" && response.total_pages > 0) {
      setTotalPages(response.total_pages);
    }
  }, []);

  const undo = useCallback(async () => {
    if (!documentId) return;
    if (sessionPayloadKind !== "pdf") return;
    if (!canUndo) return;
    try {
      const resp = await redactionAPI.sessionActions(documentId, [
        { type: "UNDO" } as SessionAction,
      ]);
      applyPdfSession(resp);
    } catch (err) {
      console.warn("Undo failed:", err);
    }
  }, [applyPdfSession, canUndo, documentId, sessionPayloadKind]);

  const redo = useCallback(async () => {
    if (!documentId) return;
    if (sessionPayloadKind !== "pdf") return;
    if (!canRedo) return;
    try {
      const resp = await redactionAPI.sessionActions(documentId, [
        { type: "REDO" } as SessionAction,
      ]);
      applyPdfSession(resp);
    } catch (err) {
      console.warn("Redo failed:", err);
    }
  }, [applyPdfSession, canRedo, documentId, sessionPayloadKind]);

  const restoreFromStoredSession = useCallback(
    async (stored: StoredRedactionSession) => {
      isRestoringRef.current = true;
      restoredFromSessionRef.current = true;
      try {
        setDocumentId(stored.documentId);
        setPayloadType(stored.payloadType ?? "lab");
        setSessionPayloadKind(stored.sessionPayloadKind ?? "pdf");
        setCurrentPage(stored.currentPage ?? 0);
        setTotalPages(stored.totalPages ?? 0);
        setZoomState(stored.zoom ?? 1);
        setMode(stored.mode === "view" ? "view" : "edit");

        // Backend owns box/session state; frontend restores only UI state.
        setRedactionBoxes([]);
        setManualBoxes([]);
        setKeepBoxes([]);
        setCanUndo(false);
        setCanRedo(false);
        setWhitelistAdditions([]);
        setBlacklistAdditions([]);

        // Clear sensitive/text state; rehydrate from backend.
        setTextSpans([]);
        setManualTextSpans([]);
        setRemovedSpanIds(new Set(stored.removedSpanIds ?? []));
        setRemovedManualSpanIds(new Set(stored.removedManualSpanIds ?? []));
        setSourceText("");
        setRedactedTextPreview("");
        setStats(null);
        setAllPagePreviews({});
        setPagePreview("");
        setPagePreviewSizes({});

        setFile(null);
        setTextPayload(null);
        setLoading(false);
        setSessionContext({
          roomNumber: stored.roomNumber,
          isAiPatientMode: stored.isAiPatientMode,
        });
        hasAttemptedRestoreRef.current = true;

        try {
          const response = await redactionAPI.getSession(stored.documentId);
          const responseKind: SessionPayloadKind =
            response.payload_type === "text" ? "text" : "pdf";
          setSessionPayloadKind(responseKind);
          setStats(response.stats ?? null);
          setCanUndo(!!response.can_undo);
          setCanRedo(!!response.can_redo);
          setWhitelistAdditions(response.whitelist_additions ?? []);
          setBlacklistAdditions(response.blacklist_additions ?? []);

          if (responseKind === "text") {
            const text = response.source_text ?? "";
            setSourceText(text);
            setRedactedTextPreview(response.redacted_text ?? "");
            setTextSpans(response.text_spans ?? []);
            setTotalPages(0);

            const storedDrafts: StoredTextSpanDraft[] =
              stored.manualTextSpans ?? [];
            const rebuiltManualSpans: TextSpan[] = storedDrafts
              .map((draft, idx) => {
                const start = Math.max(0, Math.min(text.length, draft.start));
                const end = Math.max(start, Math.min(text.length, draft.end));
                const span_id =
                  draft.span_id ?? `manual_restored_${idx}_${start}_${end}`;
                return {
                  span_id,
                  start,
                  end,
                  label: draft.label ?? "MANUAL",
                  text: text.slice(start, end),
                  is_manual: true,
                };
              })
              .filter((span) => span.end > span.start && span.text.length > 0);
            setManualTextSpans(rebuiltManualSpans);
          } else {
            setRedactionBoxes(response.redaction_boxes ?? []);
            setKeepBoxes(response.keep_boxes ?? []);
            setManualBoxes(response.manual_boxes ?? []);
            if (typeof response.total_pages === "number") {
              setTotalPages(response.total_pages);
            }
          }
        } catch (err) {
          console.warn(
            "Failed to rehydrate PHI redaction session from backend:",
            err
          );
        }
      } finally {
        isRestoringRef.current = false;
      }
    },
    []
  );

  // ---------------------------------------------------------------------------
  // Service health + navigation state
  // ---------------------------------------------------------------------------

  const checkServiceHealth = useCallback(async () => {
    try {
      const result = await redactionAPI.checkHealth?.();
      if (result) {
        setServiceStatus("online");
      } else {
        setServiceStatus("offline");
      }
    } catch (err) {
      console.error("Redaction service health check failed:", err);
      setServiceStatus("offline");
    }
  }, []);

  useEffect(() => {
    void checkServiceHealth();
  }, [checkServiceHealth]);

  // Clean up prior temp artifacts when switching to a new documentId.
  useEffect(() => {
    const prev = lastDocumentIdRef.current;
    if (prev && prev !== documentId) {
      void cleanupDocument(prev);
    }
    lastDocumentIdRef.current = documentId;
  }, [cleanupDocument, documentId]);

  // Attempt session restore on mount if no file provided via nav state
  useEffect(() => {
    if (hasAttemptedRestoreRef.current || isRestoringRef.current) return;
    if (documentId) return;
    const navState = location.state as any;
    const navHasPayload = !!(navState?.file || navState?.text);
    const shouldPreferStoredSession = didReloadRef.current || !navHasPayload;
    if (!shouldPreferStoredSession) {
      // Fresh navigation with a payload should win over restoring an old session.
      hasAttemptedRestoreRef.current = true;
      return;
    }

    const stored = loadRedactionSession();
    if (stored) {
      void restoreFromStoredSession(stored);
    } else {
      hasAttemptedRestoreRef.current = true;
    }
  }, [documentId, location.state, restoreFromStoredSession]);

  // If navigated with file or text, override any existing session
  useEffect(() => {
    if (isRestoringRef.current || restoredFromSessionRef.current) return;
    const navState = location.state as any;
    if (!navState) {
      if (!hasAttemptedRestoreRef.current && !documentId) {
        const stored = loadRedactionSession();
        if (stored) {
          void restoreFromStoredSession(stored);
        } else {
          hasAttemptedRestoreRef.current = true;
        }
      }
      return;
    }

    // On hard refresh, history.state can still contain the original payload.
    // Prefer restoring the persisted session (if present) to avoid re-detecting.
    if (didReloadRef.current && !documentId) {
      const stored = loadRedactionSession();
      if (stored) {
        void restoreFromStoredSession(stored);
        return;
      }
    }
    if (hasHydratedNavStateRef.current && (navState.file || navState.text))
      return;

    const nextPayloadType = navState.payloadType ?? navState.fileType;
    if (nextPayloadType && nextPayloadType !== payloadType) {
      setPayloadType(nextPayloadType);
    }

    if (
      navState.roomNumber !== undefined ||
      navState.isAiPatientMode !== undefined
    ) {
      setSessionContext({
        roomNumber: navState.roomNumber,
        isAiPatientMode: navState.isAiPatientMode,
      });
    }

    if (navState.text) {
      clearRedactionSession();
      restoredFromSessionRef.current = false;
      hasHydratedNavStateRef.current = true;
      setTextPayload({
        content: navState.text,
        filename: navState.filename ?? "prior_note.pdf",
      });
      setFile(null);
      try {
        const nextState = { ...navState };
        delete nextState.file;
        delete nextState.text;
        delete nextState.filename;
        navigate(location.pathname, { replace: true, state: nextState });
      } catch {
        /* no-op */
      }
      return;
    }

    if (navState.file) {
      clearRedactionSession();
      restoredFromSessionRef.current = false;
      hasHydratedNavStateRef.current = true;
      setFile(navState.file);
      setTextPayload(null);
      try {
        const nextState = { ...navState };
        delete nextState.file;
        delete nextState.text;
        delete nextState.filename;
        navigate(location.pathname, { replace: true, state: nextState });
      } catch {
        /* no-op */
      }
    }
  }, [
    documentId,
    location.pathname,
    location.state,
    navigate,
    restoreFromStoredSession,
  ]);

  // ✅ FIX #1: Only run analysis when file/text changes AND we're not applying
  useEffect(() => {
    if (isRestoringRef.current) return;
    if (isApplyingRef.current) return; // Don't re-analyze during apply
    if (file || textPayload) {
      void handleAnalyzePDF();
    }
  }, [file, textPayload]);

  // ✅ FIX #2: Fetch preview ONCE per page at fixed zoom - NO dependency on zoom state
  useEffect(() => {
    if (!documentId || sessionPayloadKind === "text" || totalPages === 0) {
      setPagePreview("");
      return;
    }

    // Check if we already have this page cached
    const cached = allPagePreviews[currentPage];
    if (cached) {
      setPagePreview(cached);
      return;
    }

    // Fetch the page at fixed zoom
    let cancelled = false;
    const load = async () => {
      try {
        const img = await redactionAPI.getPagePreview(
          documentId,
          currentPage,
          PREVIEW_FETCH_ZOOM // Always fetch at max quality
        );
        if (cancelled) return;
        setPagePreview(img);
        setAllPagePreviews((prev) => ({ ...prev, [currentPage]: img }));
      } catch (err) {
        console.error("Failed to load page preview:", err);
        if (!cancelled) {
          setPagePreview("");
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    allPagePreviews,
    currentPage,
    documentId,
    sessionPayloadKind,
    totalPages,
    PREVIEW_FETCH_ZOOM,
  ]);
  // ⚠️ NOTE: No 'zoom' in dependencies! This is the key fix.

  // Track preview image pixel sizes so we can CSS-scale canvases for zoom.
  useEffect(() => {
    if (sessionPayloadKind === "text") return;
    if (!totalPages) return;

    const missing: Array<[number, string]> = [];
    for (let page = 0; page < totalPages; page++) {
      const src = allPagePreviews[page];
      if (!src) continue;
      if (!pagePreviewSizes[page]) missing.push([page, src]);
    }
    if (missing.length === 0) return;

    let cancelled = false;
    missing.forEach(([page, src]) => {
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        setPagePreviewSizes((prev) => {
          if (prev[page]) return prev;
          return { ...prev, [page]: { width: img.width, height: img.height } };
        });
      };
      img.src = src;
    });

    return () => {
      cancelled = true;
    };
  }, [allPagePreviews, pagePreviewSizes, sessionPayloadKind, totalPages]);

  const redrawCanvasForPage = useCallback(
    (pageIndex: number, canvas: HTMLCanvasElement | null) => {
      if (!canvas) return;
      const src = allPagePreviews[pageIndex];
      if (!src) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const img = new Image();
      img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);

        const z = PREVIEW_FETCH_ZOOM;

        redactionBoxes.forEach((box) => {
          if (box.page !== pageIndex) return;
          if (box.is_removed) return;

          const x0 = box.x0 * z;
          const y0 = box.y0 * z;
          const w = (box.x1 - box.x0) * z;
          const h = (box.y1 - box.y0) * z;

          ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
          ctx.fillRect(x0, y0, w, h);
          ctx.strokeStyle = "black";
          ctx.lineWidth = 1;
          ctx.strokeRect(x0, y0, w, h);

          if (box.overlay_text) {
            const fontSize = Math.min(h * 0.5, 10);
            ctx.font = `${fontSize}px Arial`;
            ctx.fillStyle = "white";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(box.overlay_text, x0 + w / 2, y0 + h / 2);
          }
        });

        manualBoxes.forEach((box) => {
          if (box.page !== pageIndex) return;
          if (box.is_removed) return;

          const x0 = box.x0 * z;
          const y0 = box.y0 * z;
          const w = (box.x1 - box.x0) * z;
          const h = (box.y1 - box.y0) * z;

          ctx.fillStyle = "rgba(255, 0, 0, 0.5)";
          ctx.fillRect(x0, y0, w, h);
          ctx.strokeStyle = "red";
          ctx.lineWidth = 2;
          ctx.strokeRect(x0, y0, w, h);
        });

        // selection remain accross mode
        if (keepBoxes.some((b) => b.page === pageIndex && !b.is_removed)) {
          drawCropOverlay(ctx, pageIndex, z);
        }
      };
      img.src = src;
    },
    [PREVIEW_FETCH_ZOOM, allPagePreviews, manualBoxes, mode, redactionBoxes, keepBoxes]
  );

  // Ensure sidebar thumbnails are available (one fetch per page at preferred zoom)
  useEffect(() => {
    if (!documentId || sessionPayloadKind === "text" || totalPages === 0)
      return;

    const missingPages: number[] = [];
    for (let i = 0; i < totalPages; i++) {
      if (!allPagePreviews[i]) missingPages.push(i);
    }
    if (missingPages.length === 0) return;

    let cancelled = false;
    const loadMissing = async () => {
      try {
        const entries = await Promise.all(
          missingPages.map(async (page) => {
            const img = await redactionAPI.getPagePreview(
              documentId,
              page,
              PREVIEW_FETCH_ZOOM
            );
            return [page, img] as const;
          })
        );
        if (cancelled) return;
        setAllPagePreviews((prev) => {
          const next = { ...prev };
          for (const [page, img] of entries) {
            next[page] = img;
          }
          return next;
        });
      } catch (err) {
        console.warn("Failed to load some page previews:", err);
      }
    };
    void loadMissing();
    return () => {
      cancelled = true;
    };
  }, [
    documentId,
    allPagePreviews,
    sessionPayloadKind,
    totalPages,
    PREVIEW_FETCH_ZOOM,
  ]);

  // Persist detected session details so refreshes can resume without re-running detection.
  useEffect(() => {
    if (!documentId) {
      return;
    }

    const storedManualTextSpans: StoredTextSpanDraft[] = manualTextSpans.map(
      (span) => ({
        span_id: span.span_id,
        start: span.start,
        end: span.end,
        label: span.label,
      })
    );

    const snapshot: StoredRedactionSession = {
      documentId,
      payloadType,
      sessionPayloadKind,
      currentPage,
      totalPages,
      zoom,
      mode,
      removedSpanIds: Array.from(removedSpanIds),
      removedManualSpanIds: Array.from(removedManualSpanIds),
      manualTextSpans: storedManualTextSpans,
      roomNumber: sessionContext.roomNumber,
      isAiPatientMode: sessionContext.isAiPatientMode,
      timestamp: Date.now(),
    };

    saveRedactionSession(snapshot);
  }, [
    currentPage,
    documentId,
    manualTextSpans,
    mode,
    payloadType,
    removedManualSpanIds,
    removedSpanIds,
    sessionContext,
    sessionPayloadKind,
    totalPages,
    zoom,
  ]);

  // ---------------------------------------------------------------------------
  // File selection + analysis
  // ---------------------------------------------------------------------------

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    restoredFromSessionRef.current = false;
    clearRedactionSession();
    setFile(selected);
    setTextPayload(null);
  };

  const handleAnalyzePDF = async () => {
    if (!file && !textPayload) return;
    setLoading(true);
    try {
      const response = await redactionAPI.detectPHI(
        textPayload ? { text: textPayload.content } : { file: file as File }
      );
      setSessionPayloadKind(response.payload_type === "text" ? "text" : "pdf");

      if (response.payload_type === "text") {
        setDocumentId(response.document_id);
        setTextSpans(response.text_spans ?? []);
        setManualTextSpans([]);
        setRemovedSpanIds(new Set());
        setRemovedManualSpanIds(new Set());
        setSourceText(response.source_text ?? textPayload?.content ?? "");
        setRedactedTextPreview(response.redacted_text ?? "");
        setRedactionBoxes([]);
        setKeepBoxes([]);
        setManualBoxes([]);
        setCanUndo(false);
        setCanRedo(false);
        setTotalPages(0);
        setStats(response.stats ?? null);
        setCurrentPage(0);
        setAllPagePreviews({});
        setPagePreview("");
        setPagePreviewSizes({});
        setCanUndo(false);
        setCanRedo(false);
        setWhitelistAdditions([]);
        setBlacklistAdditions([]);
        return;
      }

      // shape of response is based on your existing redactionApi.ts
      setTextSpans([]);
      setManualTextSpans([]);
      setRemovedSpanIds(new Set());
      setRemovedManualSpanIds(new Set());
      setSourceText("");
      setRedactedTextPreview("");
      setDocumentId(response.document_id);
      setRedactionBoxes(response.redaction_boxes);
      setManualBoxes(response.manual_boxes ?? []);
      setKeepBoxes(response.keep_boxes ?? []);
      setCanUndo(!!response.can_undo);
      setCanRedo(!!response.can_redo);
      setTotalPages(response.total_pages);
      setCurrentPage(0);
      setStats(response.stats ?? null);
      setAllPagePreviews(response.page_previews ?? {});
      setPagePreview("");
      setPagePreviewSizes({});
      setWhitelistAdditions(response.whitelist_additions ?? []);
      setBlacklistAdditions(response.blacklist_additions ?? []);
    } catch (error: any) {
      console.error("PHI detection failed:", error);
      alert(
        `❌ PHI detection failed: ${error?.response?.data?.detail ?? error.message ?? "Unknown error"
        }`
      );
    } finally {
      setLoading(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Canvas interactions (add / remove)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (mode !== "view") return;
    if (!isDrawing && !drawStart) return;
    drawStartPxRef.current = null;
    setIsDrawing(false);
    setDrawStart(null);
  }, [mode, isDrawing, drawStart]);

  const handleCanvasClick = (
    event: React.MouseEvent<HTMLCanvasElement>,
    _pageIndex?: number
  ) => {
    if (mode !== "edit" && mode !== "crop") return;
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    if (mode === "crop") {
      void handleToggleKeepBox(event);
      return;
    }
    void handleRemoveBox(event);
  };
  const handleToggleKeepBox = async (
    event: React.MouseEvent<HTMLCanvasElement>
  ) => {
    if (!documentId) return;
    if (sessionPayloadKind !== "pdf") return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) * canvas.width) / rect.width;
    const y = ((event.clientY - rect.top) * canvas.height) / rect.height;

    const z = PREVIEW_FETCH_ZOOM;

    const hit = (b: KeepBox) => {
      const x0 = b.x0 * z;
      const y0 = b.y0 * z;
      const x1 = b.x1 * z;
      const y1 = b.y1 * z;
      return b.page === currentPage && x >= x0 && x <= x1 && y >= y0 && y <= y1;
    };

    const picked = keepBoxes.find(hit);
    if (!picked) return;

    const action: SessionAction = picked.is_removed
      ? { type: "RESTORE_KEEP_BOX", box_id: picked.box_id }
      : { type: "REMOVE_KEEP_BOX", box_id: picked.box_id };

    try {
      const resp = await redactionAPI.sessionActions(documentId, [action]);
      applyPdfSession(resp);
    } catch (err) {
      console.warn("Toggle keep box failed:", err);
    }
  };

  const handleRemoveBox = async (
    event: React.MouseEvent<HTMLCanvasElement>
  ) => {
    if (!documentId) return;
    if (sessionPayloadKind !== "pdf") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) * canvas.width) / rect.width;
    const y = ((event.clientY - rect.top) * canvas.height) / rect.height;

    const z = PREVIEW_FETCH_ZOOM;
    const pdfX = x / z;
    const pdfY = y / z;

    // If crop regions exist on this page, disable edits outside them.
    if (!isPointInActiveKeep(currentPage, pdfX, pdfY)) return;

    const activeKeeps = getActiveKeepsForPage(currentPage);
    const hasKeepConstraint = activeKeeps.length > 0;
    const single = !!event.shiftKey;

    const hitTest = (box: RedactionBox) => {
      const x0 = box.x0 * z;
      const y0 = box.y0 * z;
      const x1 = box.x1 * z;
      const y1 = box.y1 * z;
      return x >= x0 && x <= x1 && y >= y0 && y <= y1;
    };

    let action: SessionAction | null = null;

    const tryPick = (
      boxes: RedactionBox[],
      opts: { preferActive: boolean }
    ) => {
      const { preferActive } = opts;
      for (const box of boxes) {
        if (box.page !== currentPage) continue;
        if (preferActive && box.is_removed) continue;
        if (!preferActive && !box.is_removed) continue;
        if (!hitTest(box)) continue;
        return box;
      }
      return null;
    };

    const pickedAi = tryPick(redactionBoxes, { preferActive: true });
    if (pickedAi) {
      if (pickedAi.is_removed) {
        action = single
          ? { type: "RESTORE_BOX", box_id: pickedAi.box_id }
          : {
            type: "BULK_RESTORE_SIMILAR",
            box_id: pickedAi.box_id,
            updates: hasKeepConstraint
              ? { scope: { page: currentPage, keep_only: true } }
              : undefined,
          };
      } else {
        action = single
          ? { type: "REMOVE_BOX", box_id: pickedAi.box_id }
          : {
            type: "BULK_REMOVE_SIMILAR",
            box_id: pickedAi.box_id,
            updates: hasKeepConstraint
              ? { scope: { page: currentPage, keep_only: true } }
              : undefined,
          };
      }
    } else {
      const pickedManual = tryPick(manualBoxes, { preferActive: true });
      if (pickedManual) {
        if (pickedManual.is_removed) {
          action = single
            ? { type: "RESTORE_MANUAL_BOX", box_id: pickedManual.box_id }
            : {
              type: "BULK_RESTORE_SIMILAR",
              box_id: pickedManual.box_id,
              updates: hasKeepConstraint
                ? { scope: { page: currentPage, keep_only: true } }
                : undefined,
            };
        } else {
          action = single
            ? { type: "REMOVE_MANUAL_BOX", box_id: pickedManual.box_id }
            : {
              type: "BULK_REMOVE_SIMILAR",
              box_id: pickedManual.box_id,
              updates: hasKeepConstraint
                ? { scope: { page: currentPage, keep_only: true } }
                : undefined,
            };
        }
      }
    }

    if (!action) return;
    try {
      const resp = await redactionAPI.sessionActions(documentId, [action]);
      applyPdfSession(resp);
    } catch (err) {
      console.warn("Remove box failed:", err);
    }
  };

  const handleMouseDown = (
    event: React.MouseEvent<HTMLCanvasElement>,
    _pageIndex?: number
  ) => {
    if (mode !== "edit" && mode !== "crop") return;
    if (event.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) * canvas.width) / rect.width;
    const y = ((event.clientY - rect.top) * canvas.height) / rect.height;

    const z = PREVIEW_FETCH_ZOOM;
    const pdfX = x / z;
    const pdfY = y / z;

    // In edit mode, if crop regions exist on this page, start drawing only inside them.
    if (mode === "edit" && !isPointInActiveKeep(currentPage, pdfX, pdfY)) return;

    drawStartPxRef.current = { x, y };
    setIsDrawing(true);
    setDrawStart({ x: pdfX, y: pdfY });
  };

  const handleMouseMove = (
    event: React.MouseEvent<HTMLCanvasElement>,
    _pageIndex?: number
  ) => {
    if (mode !== "edit" && mode !== "crop") return;
    if (!isDrawing || !drawStart) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    redrawCanvas();

    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) * canvas.width) / rect.width;
    const y = ((event.clientY - rect.top) * canvas.height) / rect.height;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const z = PREVIEW_FETCH_ZOOM;
    const startX = drawStart.x * z;
    const startY = drawStart.y * z;

    ctx.strokeStyle = mode === "crop" ? "rgba(0, 255, 255, 0.95)" : "red";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.strokeRect(startX, startY, x - startX, y - startY);
    ctx.setLineDash([]);
  };

  const handleMouseUp = async (
    event: React.MouseEvent<HTMLCanvasElement>,
    _pageIndex?: number
  ) => {
    if (mode !== "edit" && mode !== "crop") return;
    if (!isDrawing || !drawStart) return;
    if (!documentId) return;
    if (sessionPayloadKind !== "pdf") return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) * canvas.width) / rect.width;
    const y = ((event.clientY - rect.top) * canvas.height) / rect.height;

    const z = PREVIEW_FETCH_ZOOM;
    const pdfX = x / z;
    const pdfY = y / z;

    const startPx = drawStartPxRef.current;
    const isClick = startPx
      ? Math.abs(x - startPx.x) < 3 && Math.abs(y - startPx.y) < 3
      : true;

    const x0 = Math.min(drawStart.x, pdfX);
    const y0 = Math.min(drawStart.y, pdfY);
    const x1 = Math.max(drawStart.x, pdfX);
    const y1 = Math.max(drawStart.y, pdfY);

    // If user didn't drag, treat it as a click (remove uses onClick handler).
    if (isClick) {
      drawStartPxRef.current = null;
      setIsDrawing(false);
      setDrawStart(null);
      return;
    }

    if (mode === "crop") {
      const keepPayload = {
        page: currentPage,
        x0,
        y0,
        x1,
        y1,
      };

      try {
        const resp = await redactionAPI.sessionActions(documentId, [
          { type: "ADD_KEEP_BOX", box: keepPayload },
        ]);
        applyPdfSession(resp);
      } catch (err) {
        console.warn("Add keep box failed:", err);
      }
    } else {
      const basePayload: Omit<RedactionBox, "box_id"> = {
        page: currentPage,
        x0,
        y0,
        x1,
        y1,
        entity_type: "MANUAL",
        confidence: 1,
        is_auto: false,
        is_removed: false,
        overlay_text: "REDACTED",
      };

      const activeKeeps = getActiveKeepsForPage(currentPage);
      const hasKeepConstraint = activeKeeps.length > 0;
      const single = !!event.shiftKey; // Shift key controls single vs bulk, NOT keep constraint

      try {
        const actions: SessionAction[] = [];

        if (hasKeepConstraint) {
          // Clip the drawn box to keep regions
          for (const k of activeKeeps) {
            const intersection = intersectRect(
              { x0, y0, x1, y1 },
              { x0: k.x0, y0: k.y0, x1: k.x1, y1: k.y1 }
            );
            if (!intersection) continue;

            const clippedPayload = { ...basePayload, ...intersection };

            // Shift = single area line extraction, no Shift = bulk across pages
            actions.push(
              single
                ? { type: "ADD_MANUAL_BOX", box: clippedPayload }
                : {
                  type: "BULK_ADD_MANUAL_BOX_SIMILAR",
                  box: clippedPayload,
                  updates: { scope: { page: currentPage, keep_only: true } },
                }
            );
          }
          if (actions.length === 0) return;
        } else {
          // Shift = single area line extraction, no Shift = bulk across all pages
          actions.push(
            single
              ? { type: "ADD_MANUAL_BOX", box: basePayload }
              : { type: "BULK_ADD_MANUAL_BOX_SIMILAR", box: basePayload }
          );
        }

        const resp = await redactionAPI.sessionActions(documentId, actions);
        applyPdfSession(resp);
      } catch (err) {
        console.warn("Add manual box failed:", err);
      }
    }

    suppressNextClickRef.current = true;
    drawStartPxRef.current = null;
    setIsDrawing(false);
    setDrawStart(null);
  };

  // ---------------------------------------------------------------------------
  // Text redaction interactions
  // ---------------------------------------------------------------------------

  const toggleTextSpan = (spanId: string, isManual: boolean) => {
    if (isManual) {
      setRemovedManualSpanIds((prev) => {
        const next = new Set(prev);
        if (next.has(spanId)) {
          next.delete(spanId);
        } else {
          next.add(spanId);
        }
        return next;
      });
    } else {
      setRemovedSpanIds((prev) => {
        const next = new Set(prev);
        if (next.has(spanId)) {
          next.delete(spanId);
        } else {
          next.add(spanId);
        }
        return next;
      });
    }
  };

  const addManualTextSpan = (
    start: number,
    end: number,
    text: string,
    label = "MANUAL"
  ) => {
    if (!text || end <= start) return;
    const spanId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? `manual_${crypto.randomUUID().slice(0, 8)}`
        : `manual_${Date.now()}`;

    const newSpan: TextSpan = {
      span_id: spanId,
      start,
      end,
      label,
      text,
      is_manual: true,
    };

    setManualTextSpans((prev) => [...prev, newSpan]);
    setRemovedManualSpanIds((prev) => {
      const next = new Set(prev);
      next.delete(spanId);
      return next;
    });
  };

  // ---------------------------------------------------------------------------
  // Canvas drawing
  // ---------------------------------------------------------------------------
  const drawCropOverlay = (ctx: CanvasRenderingContext2D, pageIndex: number, z: number) => {
    const activeKeeps = keepBoxes.filter((b) => b.page === pageIndex && !b.is_removed);
    if (activeKeeps.length === 0) return;

    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.2)";
    ctx.beginPath();
    ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);

    for (const b of activeKeeps) {
      const x0 = b.x0 * z;
      const y0 = b.y0 * z;
      const w = (b.x1 - b.x0) * z;
      const h = (b.y1 - b.y0) * z;
      ctx.rect(x0, y0, w, h);
    }

    ctx.fill("evenodd");
    ctx.restore();

    // Draw ONLY active keep borders (no removed dashed boxes)
    ctx.save();
    ctx.strokeStyle = "rgba(0, 255, 255, 0.95)";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    for (const b of activeKeeps) {
      const x0 = b.x0 * z;
      const y0 = b.y0 * z;
      const w = (b.x1 - b.x0) * z;
      const h = (b.y1 - b.y0) * z;
      ctx.strokeRect(x0, y0, w, h);
    }
    ctx.restore();
  };


  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pagePreview) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      // ✅ Draw boxes at the zoom level the preview was fetched at
      const z = PREVIEW_FETCH_ZOOM;
      redactionBoxes.forEach((box) => {
        if (box.page !== currentPage) return;
        if (box.is_removed) return;

        const x0 = box.x0 * z;
        const y0 = box.y0 * z;
        const w = (box.x1 - box.x0) * z;
        const h = (box.y1 - box.y0) * z;

        ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
        ctx.fillRect(x0, y0, w, h);
        ctx.strokeStyle = "black";
        ctx.lineWidth = 1;
        ctx.strokeRect(x0, y0, w, h);

        if (box.overlay_text) {
          const fontSize = Math.min(h * 0.5, 10);
          ctx.font = `${fontSize}px Arial`;
          ctx.fillStyle = "white";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(box.overlay_text, x0 + w / 2, y0 + h / 2);
        }
      });

      manualBoxes.forEach((box) => {
        if (box.page !== currentPage) return;
        if (box.is_removed) return;

        const x0 = box.x0 * z;
        const y0 = box.y0 * z;
        const w = (box.x1 - box.x0) * z;
        const h = (box.y1 - box.y0) * z;

        ctx.fillStyle = "rgba(255, 0, 0, 0.5)";
        ctx.fillRect(x0, y0, w, h);
        ctx.strokeStyle = "red";
        ctx.lineWidth = 2;
        ctx.strokeRect(x0, y0, w, h);
      });

      if (keepBoxes.some((b) => b.page === currentPage && !b.is_removed)) { drawCropOverlay(ctx, currentPage, z) }
    };
    img.src = pagePreview;
  }, [
    currentPage,
    manualBoxes,
    mode,
    pagePreview,
    redactionBoxes,
    PREVIEW_FETCH_ZOOM,
    keepBoxes,
  ]);

  useEffect(() => {
    redrawCanvas();
  }, [redrawCanvas]);

  const handleApplyRedactions = async () => {
    if (!documentId) return;

    // ✅ FIX #1: Set flag to prevent re-running detection
    isApplyingRef.current = true;
    setLoading(true);
    let applied = false;
    const appliedDocumentId = documentId;
    try {
      let textStatePayload: TextRedactionStatePayload | undefined;
      if (sessionPayloadKind === "text") {
        const activeManualTextSpans = manualTextSpans.filter(
          (span) => !removedManualSpanIds.has(span.span_id)
        );
        textStatePayload = {
          removed_span_ids: Array.from(removedSpanIds),
          added_spans: activeManualTextSpans.map((span) => ({
            span_id: span.span_id,
            start: span.start,
            end: span.end,
            label: span.label,
            text: span.text,
          })),
        };
      }

      const result =
        sessionPayloadKind === "text"
          ? await redactionAPI.applyRedactions(
            documentId,
            [],
            [],
            [],
            [],
            [],
            textStatePayload
          )
          : await redactionAPI.finalizeSession(documentId);
      applied = true; // API succeeded; ensure cleanup runs even if later steps fail

      const isPriorNote =
        payloadType === "priorNote" || sessionPayloadKind === "text";
      const fileType = payloadType === "imaging" ? "imaging" : "lab";
      const filename = result?.final_filename ?? "redacted.pdf";

      const navStateForScope = location.state as any;
      const scopeRoomNumber =
        navStateForScope?.roomNumber ?? sessionContext.roomNumber;
      const scopeIsAiMode =
        navStateForScope?.isAiPatientMode ?? sessionContext.isAiPatientMode;
      const storageScope =
        typeof scopeRoomNumber === "number"
          ? { roomNumber: scopeRoomNumber, isAiPatientMode: scopeIsAiMode }
          : undefined;

      if (sessionPayloadKind === "text") {
        if (result?.redacted_text) {
          saveRedactedPriorNoteToStorage(result.redacted_text, storageScope);
        }
      } else if (isPriorNote) {
        if (result?.redacted_text) {
          saveRedactedPriorNoteToStorage(result.redacted_text, storageScope);
        }
      } else {
        const blob = await redactionAPI.downloadPDF(documentId);
        await saveRedactedFileToStorage(
          fileType,
          blob,
          filename,
          undefined,
          storageScope
        );
      }

      // Navigate back to dashboard with state to reopen modal
      const navState = location.state as any;
      const roomNumber = navState?.roomNumber ?? sessionContext.roomNumber;
      const isAiMode =
        navState?.isAiPatientMode ?? sessionContext.isAiPatientMode;

      navigate("/dashboard", {
        state: {
          reopenModal: true,
          roomNumber,
          isAiPatientMode: isAiMode,
          redactedFileType: payloadType,
        },
      });

      clearRedactionSession();
      restoredFromSessionRef.current = false;
    } catch (error: any) {
      console.error("Apply redactions failed:", error);
      alert(
        `❌ Error applying redactions: ${error?.response?.data?.detail ?? error.message ?? "Unknown error"
        }`
      );
    } finally {
      // Always attempt backend cleanup once applyRedactions ran, even if later steps failed.
      if (applied && appliedDocumentId) {
        clearRedactionSession();
        await cleanupDocument(appliedDocumentId);
      }
      setLoading(false);
      // ✅ FIX #1: Reset flag after apply is complete
      isApplyingRef.current = false;
    }
  };

  // ---------------------------------------------------------------------------
  // Public API from hook
  // ---------------------------------------------------------------------------

  return {
    // service
    serviceStatus,
    checkServiceHealth,

    // file
    file,
    setFile,
    fileInputRef,
    handleFileSelect,
    handleAnalyzePDF,

    // redaction state
    documentId,
    redactionBoxes,
    manualBoxes,
    stats,
    sessionPayloadKind,
    sourceText,
    textSpans,
    manualTextSpans,
    removedSpanIds,
    removedManualSpanIds,
    redactedTextPreview,

    // pages & zoom
    currentPage,
    setCurrentPage,
    totalPages,
    zoom,
    setZoom: (value: number | ((z: number) => number)) => {
      setZoomState((prev) => {
        const next =
          typeof value === "function"
            ? (value as (z: number) => number)(prev)
            : value;
        return clampZoom(next);
      });
    },
    mode,
    setMode,

    // undo / redo
    canUndo,
    canRedo,
    undo,
    redo,

    // previews & canvas
    pagePreview,
    allPagePreviews,
    pagePreviewSizes,
    redrawCanvasForPage,
    canvasRef,
    handleCanvasClick,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,

    // flags
    loading,

    // learning (session)
    whitelistAdditions,
    blacklistAdditions,
    revertWhitelistAddition: async (term: string) => {
      if (!documentId || sessionPayloadKind !== "pdf") return;
      const resp = await redactionAPI.sessionActions(documentId, [
        { type: "REVERT_WHITELIST_ADDITION", term },
      ]);
      applyPdfSession(resp);
    },
    revertBlacklistAddition: async (term: string) => {
      if (!documentId || sessionPayloadKind !== "pdf") return;
      const resp = await redactionAPI.sessionActions(documentId, [
        { type: "REVERT_BLACKLIST_ADDITION", term },
      ]);
      applyPdfSession(resp);
    },

    // actions
    handleApplyRedactions,
    toggleTextSpan,
    addManualTextSpan,
  };
}
